import apiClient from '../utils/api';
export const aiApi = {
  getConfigs: () => apiClient.get<any, any[]>('/ai/models'),
  capabilities: () => apiClient.get<any, { shotDurations: number[] }>('/ai/capabilities'),
  diagnose: () => apiClient.get<any, any>('/ai/status'),
};
