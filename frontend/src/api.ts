import { client } from '../../api/generated/sdk/client.gen';

client.setConfig({ baseUrl: '' });

export * from '../../api/generated/sdk/index';
