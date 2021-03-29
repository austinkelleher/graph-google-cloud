export enum ServiceUsageListFilter {
  ENABLED = 'state:ENABLED',
  DISABLED = 'state:DISABLED',
}

export enum ServiceUsageName {
  CLOUD_FUNCTIONS = 'cloudfunctions.googleapis.com',
  STORAGE = 'storage.googleapis.com',
  SERVICE_USAGE = 'serviceusage.googleapis.com',
  IAM = 'iam.googleapis.com',
  RESOURCE_MANAGER = 'cloudresourcemanager.googleapis.com',
  COMPUTE = 'compute.googleapis.com',
  KMS = 'cloudkms.googleapis.com',
  SQL_ADMIN = 'sqladmin.googleapis.com',
  BIG_QUERY = 'bigquery.googleapis.com',
  DNS = 'dns.googleapis.com',
  CONTAINER = 'container.googleapis.com',
  LOGGING = 'logging.googleapis.com',
  MONITORING = 'monitoring.googleapis.com',
  BINARY_AUTHORIZATION = 'binaryauthorization.googleapis.com',
  PUB_SUB = 'pubsub.googleapis.com',
  APP_ENGINE = 'appengine.googleapis.com',
  CLOUD_RUN = 'run.googleapis.com',
  REDIS = 'redis.googleapis.com',
  MEMCACHE = 'memcache.googleapis.com',
}
