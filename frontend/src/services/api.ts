import axios from 'axios';
import { useAuthStore } from '../store/authStore';
import type { PreviewRecipientResponse, PreviewRenderResponse, MergeFieldDefinition, TemplateFieldBinding } from '../types';

const getApiBase = () => {
  if (import.meta.env.VITE_API_URL) {
    return `${import.meta.env.VITE_API_URL}/api`;
  }
  if (typeof window !== 'undefined' && window.location.hostname.includes('200.97.162.130')) {
    return `${window.location.protocol}//bulk-api.200.97.162.130.sslip.io/api`;
  }
  return '/api';
};

const api = axios.create({
  baseURL: getApiBase(),
  withCredentials: true,
});

// Request interceptor — attach token from store as fallback
api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Response interceptor — handle 401 with token refresh
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;
      try {
        const response = await axios.post('/api/auth/refresh', {}, { withCredentials: true });
        const { access_token } = response.data;
        useAuthStore.getState().setToken(access_token);
        originalRequest.headers.Authorization = `Bearer ${access_token}`;
        return api(originalRequest);
      } catch {
        useAuthStore.getState().logout();
        window.location.href = '/login';
      }
    }

    return Promise.reject(error);
  }
);

// ─── Campaign Preview & Field APIs ─────────────────────────────────────

export async function getPreviewRecipient(campaignCode: string, index: number): Promise<PreviewRecipientResponse> {
  const res = await api.get(`/campaigns/${campaignCode}/preview-recipient`, { params: { index } });
  return res.data;
}

export async function renderCampaignPreview(
  campaignCode: string,
  payload: {
    recipient_index?: number;
    recipient_id?: number;
    subject?: string;
    preheader?: string;
    html?: string;
    plain_text?: string;
  }
): Promise<PreviewRenderResponse> {
  const res = await api.post(`/campaigns/${campaignCode}/preview/render`, payload);
  return res.data;
}

export async function renderTemplatePreview(
  templateCode: string,
  payload: { html?: string; subject?: string; preheader?: string; merge_field_definitions?: any[] }
): Promise<{ subject: string; preheader: string; html: string; warnings: string[] }> {
  const res = await api.post(`/templates/${templateCode}/preview/render`, payload);
  return res.data;
}

export async function renderTemplateDraftPreview(
  payload: { html?: string; subject?: string; preheader?: string; merge_field_definitions?: any[] }
): Promise<{ subject: string; preheader: string; html: string; warnings: string[] }> {
  const res = await api.post(`/templates/preview/render`, payload);
  return res.data;
}

export async function getCampaignFieldDefinitions(campaignCode: string): Promise<{
  field_definitions: MergeFieldDefinition[];
  sample_values: Record<string, string>;
  total_recipients: number;
  template_field_bindings: TemplateFieldBinding[] | null;
  selected_template_id: number | null;
}> {
  const res = await api.get(`/campaigns/${campaignCode}/field-definitions`);
  return res.data;
}

export async function suggestMapping(campaignCode: string, headers: string[]): Promise<{
  found: boolean;
  column_mapping?: any;
  field_definitions?: MergeFieldDefinition[];
  source_campaign_code?: string;
}> {
  const res = await api.post(`/campaigns/${campaignCode}/suggest-mapping`, { headers });
  return res.data;
}

export async function autoMapTemplateFields(campaignCode: string): Promise<{
  bindings: TemplateFieldBinding[];
  template_fields: MergeFieldDefinition[];
  campaign_fields: MergeFieldDefinition[];
}> {
  const res = await api.post(`/campaigns/${campaignCode}/auto-map-template`);
  return res.data;
}

export default api;
