import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import Logger from 'bunyan';

import { CircuitBreakerConfiguration, CircuitBreakerConfigurationProvider } from '.';
import { checkDefined } from '../../preconditions/preconditions';

export class S3CircuitBreakerConfigurationProvider implements CircuitBreakerConfigurationProvider {
  private log: Logger;
  private fillers: CircuitBreakerConfiguration[];
  private lastUpdatedTimestamp: number;
  private client: S3Client;

  // try to refetch endpoints every 5 mins
  private static UPDATE_PERIOD_MS = 5 * 60000;
  private static FILL_RATE_THRESHOLD = 0.4;

  constructor(_log: Logger, private bucket: string, private key: string) {
    this.log = _log.child({ quoter: 'S3CircuitBreakerConfigurationProvider' });
    this.fillers = [];
    this.lastUpdatedTimestamp = Date.now();
    this.client = new S3Client({});
  }

  async getConfigurations(): Promise<CircuitBreakerConfiguration[]> {
    if (
      this.fillers.length === 0 ||
      Date.now() - this.lastUpdatedTimestamp > S3CircuitBreakerConfigurationProvider.UPDATE_PERIOD_MS
    ) {
      await this.fetchConfigurations();
      this.lastUpdatedTimestamp = Date.now();
    }
    return this.fillers;
  }

  async fetchConfigurations(): Promise<void> {
    const s3Res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.key,
      })
    );
    const s3Body = checkDefined(s3Res.Body, 's3Res.Body is undefined');
    this.fillers = JSON.parse(await s3Body.transformToString()) as CircuitBreakerConfiguration[];
    this.log.info({ config: this.fillers }, 'fetched circuit breaker config from S3');
  }

  async putConfigurations(fillRates: Map<string, number>): Promise<void> {
    const config: CircuitBreakerConfiguration[] = [];
    for (const [filler, rate] of fillRates) {
      config.push({
        name: filler,
        fadeRate: rate,
        // enabled endpoints will be able to participate in RFQ
        enabled: rate < S3CircuitBreakerConfigurationProvider.FILL_RATE_THRESHOLD,
      });
    }
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key,
        Body: JSON.stringify(config),
      })
    );
  }
}