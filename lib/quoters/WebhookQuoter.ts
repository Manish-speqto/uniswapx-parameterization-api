import { TradeType } from '@uniswap/sdk-core';
import { metric, MetricLoggerUnit } from '@uniswap/smart-order-router';
import axios, { AxiosError, AxiosResponse } from 'axios';
import Logger from 'bunyan';
import { v4 as uuidv4 } from 'uuid';

import { sendAnalyticsEvent } from '../util/analytics';
import { Metric, metricContext, QuoteRequest, QuoteResponse, EventName } from '../entities';
import { WebhookConfiguration, WebhookConfigurationProvider } from '../providers';
import { CircuitBreakerConfigurationProvider } from '../providers/circuit-breaker';
import { FillerComplianceConfigurationProvider } from '../providers/compliance';
import { Quoter, QuoterType } from '.';
import { timestampInMstoSeconds } from '../util/time';

// TODO: shorten, maybe take from env config
const WEBHOOK_TIMEOUT_MS = 500;

// Quoter which fetches quotes from http endpoints
// endpoints must return well-formed QuoteResponse JSON
export class WebhookQuoter implements Quoter {
  private log: Logger;
  private readonly ALLOW_LIST: Set<string>;

  constructor(
    _log: Logger,
    private webhookProvider: WebhookConfigurationProvider,
    private circuitBreakerProvider: CircuitBreakerConfigurationProvider,
    private complianceProvider: FillerComplianceConfigurationProvider,
    _allow_list: Set<string> = new Set<string>(['9de8f2376fef4be567f2e242fce750cca347b71853816cbc64f70d568de41ef1', '7b8d5830b35a2a2aa9b5581f8b87f6082335daacd1013fbbb05d690f3c4eae6d'])
  ) {
    this.log = _log.child({ quoter: 'WebhookQuoter' });
    this.ALLOW_LIST = _allow_list;
  }

  public async quote(request: QuoteRequest): Promise<QuoteResponse[]> {
    const endpoints = await this.getEligibleEndpoints();
    const endpointToAddrsMap = await this.complianceProvider.getEndpointToExcludedAddrsMap();
    endpoints.filter((e) => {
      return endpointToAddrsMap.get(e.endpoint) === undefined ||
        !endpointToAddrsMap.get(e.endpoint)?.has(request.swapper); 
    });
      
    this.log.info({ endpoints }, `Fetching quotes from ${endpoints.length} endpoints`);
    const quotes = await Promise.all(endpoints.map((e) => this.fetchQuote(e, request)));
    return quotes.filter((q) => q !== null) as QuoteResponse[];
  }

  public type(): QuoterType {
    return QuoterType.RFQ;
  }

  private async getEligibleEndpoints(): Promise<WebhookConfiguration[]> {
    const endpoints = await this.webhookProvider.getEndpoints();
    try {
      const config = await this.circuitBreakerProvider.getConfigurations();
      const fillerToConfigMap = new Map(config.map((c) => [c.hash, c]));
      if (config) {
        this.log.info(
          { fillerToCMap: [...fillerToConfigMap.entries()], config: config },
          `Circuit breaker config used`
        );
        const enabledEndpoints: WebhookConfiguration[] = [];
        endpoints.forEach((e) => {
          if (
            this.ALLOW_LIST.has(e.hash) ||
            (fillerToConfigMap.has(e.hash) && fillerToConfigMap.get(e.hash)?.enabled) ||
            !fillerToConfigMap.has(e.hash) // default to allowing fillers not in the config
          ) {
            this.log.info({ endpoint: e }, `Endpoint enabled`);
            enabledEndpoints.push(e);
          }
        });
        return enabledEndpoints;
      }

      return endpoints;
    } catch (e) {
      this.log.error({ error: e }, `Error getting eligible endpoints, default to returning all`);
      return endpoints;
    }
  }

  private async fetchQuote(config: WebhookConfiguration, request: QuoteRequest): Promise<QuoteResponse | null> {
    const { name, endpoint, headers } = config;
    if (config.chainIds !== undefined && !config.chainIds.includes(request.tokenInChainId)) {
      this.log.debug(
        { configuredChainIds: config.chainIds, chainId: request.tokenInChainId },
        `chainId not configured for ${endpoint}`
      );
      return null;
    }

    metric.putMetric(Metric.RFQ_REQUESTED, 1, MetricLoggerUnit.Count);
    metric.putMetric(metricContext(Metric.RFQ_REQUESTED, name), 1, MetricLoggerUnit.Count);

    const cleanRequest = request.toCleanJSON();
    cleanRequest.quoteId = uuidv4();
    const opposingCleanRequest = request.toOpposingCleanJSON();
    opposingCleanRequest.quoteId = uuidv4();

    this.log.info({ request: cleanRequest, headers }, `Webhook request to: ${endpoint}`);
    this.log.info({ request: opposingCleanRequest, headers }, `Webhook request to: ${endpoint}`);

    const before = Date.now();
    const timeoutOverride = config.overrides?.timeout;

    const axiosConfig = {
      timeout: timeoutOverride ? Number(timeoutOverride) : WEBHOOK_TIMEOUT_MS,
      ...(!!headers && { headers }),
    };

    const requestContext = {
      requestId: cleanRequest.requestId,
      quoteId: cleanRequest.quoteId,
      name: name,
      endpoint: endpoint,
      createdAt: timestampInMstoSeconds(before),
      createdAtMs: before.toString(),
      timeoutSettingMs: axiosConfig.timeout,
    };

  try {    
    
      const [hookResponse, opposite] = await Promise.all([
        axios.post(endpoint, cleanRequest, axiosConfig),
        axios.post(endpoint, opposingCleanRequest, axiosConfig),
      ]);

      metric.putMetric(Metric.RFQ_RESPONSE_TIME, Date.now() - before, MetricLoggerUnit.Milliseconds);
      metric.putMetric(
        metricContext(Metric.RFQ_RESPONSE_TIME, name),
        Date.now() - before,
        MetricLoggerUnit.Milliseconds
      );

      const rawResponse = {
        status: hookResponse.status,
        data: hookResponse.data,
        responseTimeMs: Date.now() - before,
      };

      const { response, validation } = QuoteResponse.fromRFQ(request, hookResponse.data, request.type);

      // RFQ provider explicitly elected not to quote
      if (isNonQuote(request, hookResponse, response)) {
        metric.putMetric(Metric.RFQ_NON_QUOTE, 1, MetricLoggerUnit.Count);
        metric.putMetric(metricContext(Metric.RFQ_NON_QUOTE, name), 1, MetricLoggerUnit.Count);
        await sendAnalyticsEvent({
          eventType: EventName.WEBHOOK_RESPONSE,
          eventProperties: {
            ...requestContext,
            ...rawResponse,
            responseType: 'NO_QUOTE',
          },
        });
        return null;
      }

      // RFQ provider response failed validation
      if (validation.error) {
        metric.putMetric(Metric.RFQ_FAIL_VALIDATION, 1, MetricLoggerUnit.Count);
        metric.putMetric(metricContext(Metric.RFQ_FAIL_VALIDATION, name), 1, MetricLoggerUnit.Count);
        await sendAnalyticsEvent({
          eventType: EventName.WEBHOOK_RESPONSE,
          eventProperties: {
            ...requestContext,
            ...rawResponse,
            responseType: 'VALIDATION_ERROR',
            validationError: validation.error?.details,
          },
        });
        return null;
      }

      if (response.requestId !== request.requestId) {
        metric.putMetric(Metric.RFQ_FAIL_REQUEST_MATCH, 1, MetricLoggerUnit.Count);
        metric.putMetric(metricContext(Metric.RFQ_FAIL_REQUEST_MATCH, name), 1, MetricLoggerUnit.Count);
        await sendAnalyticsEvent({
          eventType: EventName.WEBHOOK_RESPONSE,
          eventProperties: {
            ...requestContext,
            ...rawResponse,
            responseType: 'REQUEST_ID_MISMATCH',
            mismatchedRequestId: response.requestId,
          },
        });
        return null;
      }

      metric.putMetric(Metric.RFQ_SUCCESS, 1, MetricLoggerUnit.Count);
      metric.putMetric(metricContext(Metric.RFQ_SUCCESS, name), 1, MetricLoggerUnit.Count);
      await sendAnalyticsEvent({
        eventType: EventName.WEBHOOK_RESPONSE,
        eventProperties: {
          ...requestContext,
          ...rawResponse,
          responseType: 'OK',
        },
      });

      //iff valid quote, log the opposing side as well
      const opposingRequest = request.toOpposingRequest();
      const opposingResponse = QuoteResponse.fromRFQ(opposingRequest, opposite.data, opposingRequest.type);
      if (
        opposingResponse &&
        !isNonQuote(opposingRequest, opposite, opposingResponse.response) &&
        !opposingResponse.validation.error
      ) {
        this.log.info({
          eventType: 'QuoteResponse',
          body: { ...opposingResponse.response.toLog(), offerer: opposingResponse.response.swapper },
        });
      }

      return response;
    } catch (e) {
      metric.putMetric(Metric.RFQ_FAIL_ERROR, 1, MetricLoggerUnit.Count);
      metric.putMetric(metricContext(Metric.RFQ_FAIL_ERROR, name), 1, MetricLoggerUnit.Count);
      if (e instanceof AxiosError) {
        const axiosResponseType = e.code === 'ECONNABORTED' ? 'TIMEOUT' : 'HTTP_ERROR';
        await sendAnalyticsEvent({
          eventType: EventName.WEBHOOK_RESPONSE,
          eventProperties: {
            ...requestContext,
            status: e.response?.status,
            data: e.response?.data,
            responseTimeMs: Date.now() - before,
            responseType: axiosResponseType,
          },
        });
      } else {
        await sendAnalyticsEvent({
          eventType: EventName.WEBHOOK_RESPONSE,
          eventProperties: {
            ...requestContext,
            responseTimeMs: Date.now() - before,
            responseType: 'OTHER_ERROR',
            otherError: `${e}`,
          },
        });
      }
      return null;
    }
  }
}

// returns true if the given hook response is an explicit non-quote
// these should be treated differently from quote validation errors for analytics purposes
// valid non-quote responses:
// - 404
// - 0 amount quote
function isNonQuote(request: QuoteRequest, hookResponse: AxiosResponse, parsedResponse: QuoteResponse): boolean {
  if (hookResponse.status === 404) {
    return true;
  }

  const quote = request.type === TradeType.EXACT_INPUT ? parsedResponse.amountOut : parsedResponse.amountIn;
  if (quote.eq(0)) {
    return true;
  }

  return false;
}
