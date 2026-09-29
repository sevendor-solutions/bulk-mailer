import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import api from '../services/api';
import toast from 'react-hot-toast';
import {
  Save, Server, Mail, Gauge, UserCircle, Plus, Pencil, Trash2, Star,
  ToggleLeft, ToggleRight, X, Loader2, Globe, Upload, Sliders, Shield,
} from 'lucide-react';
import ConfirmDialog from '../components/ConfirmDialog';
import type { SenderIdentity } from '../types';
import {
  PALETTES, useThemeStore, generatePaletteFromPrimary, DEFAULT_APP_NAME, DEFAULT_PALETTE,
} from '../store/themeStore';
import { Check } from 'lucide-react';
import PageContainer from '../components/ui/PageContainer';
import PageHeader from '../components/ui/PageHeader';
import SegmentedControl from '../components/ui/SegmentedControl';
import EmptyState from '../components/ui/EmptyState';
import IconButton from '../components/ui/IconButton';
import StickyActionBar from '../components/ui/StickyActionBar';
import Switch from '../components/ui/Switch';
import { assetUrl } from '../constants/assets';

type Tab = 'general' | 'identities' | 'campaign-controls' | 'provider';

interface DataRetentionConfig {
  enabled: boolean;
  campaign_retention_days: number | null;
  campaign_delete_recipients: boolean;
  recipient_retention_days: number | null;
  tracking_retention_days: number | null;
  upload_retention_days: number | null;
  suppression_exempt: boolean;
}

export default function Settings() {
  const [tab, setTab] = useState<Tab>('general');

  // General Settings state
  const [appName, setAppName] = useState(DEFAULT_APP_NAME);
  const [logoUrl, setLogoUrl] = useState('');
  const [faviconUrl, setFaviconUrl] = useState('');
  const [timezone, setTimezone] = useState('UTC');
  const [themePalette, setThemePalette] = useState(DEFAULT_PALETTE);
  const [themeCustomPrimary, setThemeCustomPrimary] = useState('#4f46e5');
  const [savingGeneral, setSavingGeneral] = useState(false);

  // Email Provider state
  const [provider, setProvider] = useState('ses');
  const [sesRegion, setSesRegion] = useState('us-east-1');
  const [sesAccessKey, setSesAccessKey] = useState('');
  const [sesSecretKey, setSesSecretKey] = useState('');
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState(587);
  const [smtpUsername, setSmtpUsername] = useState('');
  const [smtpPassword, setSmtpPassword] = useState('');
  const [smtpUseTls, setSmtpUseTls] = useState(true);
  const [sandboxMode, setSandboxMode] = useState(true);
  const [maxSendRate, setMaxSendRate] = useState(14);
  const [rateLimitType, setRateLimitType] = useState<'delay' | 'per_second'>('delay');
  const [sendDelaySeconds, setSendDelaySeconds] = useState(60);
  const [saving, setSaving] = useState(false);
  const [trackingBaseUrl, setTrackingBaseUrl] = useState('');
  const [providerInfo, setProviderInfo] = useState({
    smtpPasswordSet: false, sesSecretSet: false, imapPasswordSet: false, trackingActive: false,
    trackingUrlIsPublic: false, problem: null as string | null,
  });
  const [imapEnabled, setImapEnabled] = useState(false);
  const [imapHost, setImapHost] = useState('');
  const [imapPort, setImapPort] = useState(993);
  const [imapUsername, setImapUsername] = useState('');
  const [imapPassword, setImapPassword] = useState('');
  const [imapFolder, setImapFolder] = useState('INBOX');
  const [bounceMailbox, setBounceMailbox] = useState<{
    host: string; port: number; username: string; folder: string; password_set: boolean;
    problem: string | null; check_every_seconds: number; last_success_at: string | null;
    last_error: string | null; total_marked: number;
  } | null>(null);
  const [checkingBounces, setCheckingBounces] = useState(false);
  const [bounceResult, setBounceResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [testEmail, setTestEmail] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Sender Identities state
  const [identities, setIdentities] = useState<SenderIdentity[]>([]);
  const [loadingIdentities, setLoadingIdentities] = useState(true);
  const [showIdentityForm, setShowIdentityForm] = useState(false);
  const [editingIdentity, setEditingIdentity] = useState<SenderIdentity | null>(null);
  const [identityForm, setIdentityForm] = useState({ from_email: '', from_name: '', reply_to: '', is_default: false });

  // Data Retention state
  const [deleteIdentityCode, setDeleteIdentityCode] = useState<string | null>(null);
  const [retention, setRetention] = useState<DataRetentionConfig>({
    enabled: false,
    campaign_retention_days: null,
    campaign_delete_recipients: true,
    recipient_retention_days: null,
    tracking_retention_days: null,
    upload_retention_days: null,
    suppression_exempt: true,
  });
  const [savingRetention, setSavingRetention] = useState(false);

  // Campaign Controls state
  const [campaignMode, setCampaignMode] = useState<'global' | 'user'>('global');
  const [maxRecipients, setMaxRecipients] = useState<number | null>(null);
  const [allowScheduling, setAllowScheduling] = useState(true);
  const [savingCampaignControls, setSavingCampaignControls] = useState(false);

  useEffect(() => { loadSettings(); loadIdentities(); loadGeneralSettings(); loadCampaignControls(); loadRetentionSettings(); }, []);

  const loadGeneralSettings = async () => {
    try {
      const res = await api.get('/settings/general');
      setAppName(res.data.app_name || DEFAULT_APP_NAME);
      setLogoUrl(res.data.logo_url || '');
      setFaviconUrl(res.data.favicon_url || '');
      setTimezone(res.data.timezone || 'UTC');
      setThemePalette(res.data.theme_palette || DEFAULT_PALETTE);
      setThemeCustomPrimary(res.data.theme_custom_primary || '#4f46e5');
    } catch { /* defaults */ }
  };

  const handleSaveGeneral = async () => {
    setSavingGeneral(true);
    try {
      await api.post('/settings/general', {
        app_name: appName,
        logo_url: logoUrl || null,
        favicon_url: faviconUrl || null,
        timezone,
        theme_palette: themePalette,
        theme_custom_primary: themePalette === 'custom' ? themeCustomPrimary : null,
      });
      useThemeStore.getState().setPalette(themePalette, themeCustomPrimary);
      useThemeStore.getState().loadSettings();
      toast.success('General settings saved');
    } catch (err: any) { toast.error(err.response?.data?.detail || 'Failed to save'); }
    finally { setSavingGeneral(false); }
  };

  const handleFileUpload = async (file: File, setter: (url: string) => void) => {
    const form = new FormData();
    form.append('file', file);
    try {
      const res = await api.post('/assets/upload', form, { headers: { 'Content-Type': 'multipart/form-data' } });
      setter(res.data.url);
      toast.success('File uploaded');
    } catch (err: any) { toast.error(err.response?.data?.detail || 'Upload failed'); }
  };

  const applyProviderConfig = (config: any) => {
    if (!config) return;
    setProvider(config.provider || 'ses');
    setSesRegion(config.ses_region || 'us-east-1');
    setSmtpHost(config.smtp_host || '');
    setSmtpPort(config.smtp_port || 587);
    setSmtpUsername(config.smtp_username || '');
    setSmtpUseTls(config.smtp_use_tls ?? true);
    setSandboxMode(config.sandbox_mode ?? true);
    setRateLimitType(config.rate_limit_type || 'delay');
    setSendDelaySeconds(config.send_delay_seconds ?? 60);
    setMaxSendRate(config.max_send_rate || 14);
    setTrackingBaseUrl(config.tracking_base_url || '');
    setProviderInfo({
      smtpPasswordSet: !!config.smtp_password_set,
      sesSecretSet: !!config.ses_secret_key_set,
      imapPasswordSet: !!config.imap_password_set,
      trackingActive: !!config.tracking_active,
      trackingUrlIsPublic: !!config.tracking_url_is_public,
      problem: config.problem || null,
    });
    setImapEnabled(!!config.imap_enabled);
    setImapHost(config.imap_host || '');
    setImapPort(config.imap_port || 993);
    setImapUsername(config.imap_username || '');
    setImapFolder(config.imap_folder || 'INBOX');
    // Passwords are never sent back; the fields start empty and mean "unchanged"
    setSmtpPassword('');
    setSesSecretKey('');
    setImapPassword('');
  };

  const loadBounceMailbox = async () => {
    try {
      const res = await api.get('/settings/bounce-mailbox');
      setBounceMailbox(res.data);
    } catch { /* not configured yet */ }
  };

  const loadSettings = async () => {
    try {
      const res = await api.get('/settings/email-provider');
      applyProviderConfig(res.data);
    } catch { /* Settings may not exist yet */ }
    loadBounceMailbox();
  };

  const loadIdentities = async () => {
    setLoadingIdentities(true);
    try { const res = await api.get('/sender-identities/all'); setIdentities(res.data); }
    catch { /* May not exist yet */ }
    finally { setLoadingIdentities(false); }
  };

  const loadRetentionSettings = async () => {
    try {
      const res = await api.get('/settings/data-retention');
      setRetention(res.data);
    } catch { /* defaults */ }
  };

  const saveProvider = async (): Promise<boolean> => {
    if (provider === 'smtp' && !smtpHost.trim()) {
      toast.error('Enter the SMTP host before saving');
      return false;
    }
    try {
      const res = await api.post('/settings/email-provider', {
        provider, ses_region: sesRegion,
        ses_access_key: sesAccessKey || undefined, ses_secret_key: sesSecretKey || undefined,
        smtp_host: smtpHost.trim(), smtp_port: smtpPort,
        smtp_username: smtpUsername.trim(), smtp_password: smtpPassword || undefined,
        smtp_use_tls: smtpUseTls, sandbox_mode: sandboxMode, max_send_rate: maxSendRate,
        rate_limit_type: rateLimitType, send_delay_seconds: sendDelaySeconds,
        tracking_base_url: trackingBaseUrl.trim() || undefined,
        imap_enabled: imapEnabled, imap_host: imapHost.trim(), imap_port: imapPort,
        imap_username: imapUsername.trim(), imap_password: imapPassword || undefined,
        imap_folder: imapFolder.trim() || 'INBOX',
      });
      applyProviderConfig(res.data?.config);
      loadBounceMailbox();
      return true;
    } catch (err: any) {
      toast.error(err.response?.data?.detail || 'Failed to save settings');
      return false;
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      if (await saveProvider()) toast.success('Email settings saved');
    } finally { setSaving(false); }
  };

  /** Saves first, then reads the mailbox once. Doubles as the connection test. */
  const handleCheckBounces = async () => {
    setCheckingBounces(true);
    setBounceResult(null);
    try {
      if (!(await saveProvider())) return;
      const res = await api.post('/settings/bounce-mailbox/check');
      const data = res.data;
      setBounceMailbox(data.mailbox);
      if (data.success) {
        const marked = data.recipients_marked;
        setBounceResult({
          ok: true,
          message: `Connected. ${data.messages_read} possible bounce message${data.messages_read === 1 ? '' : 's'} read, `
            + `${marked} recipient${marked === 1 ? '' : 's'} marked as bounced.`
            + (data.temporary ? ` ${data.temporary} temporary delay notice${data.temporary === 1 ? '' : 's'} ignored.` : ''),
        });
      } else {
        setBounceResult({ ok: false, message: data.error || 'The mailbox could not be read.' });
      }
    } catch (err: any) {
      setBounceResult({ ok: false, message: err.response?.data?.detail || 'The mailbox could not be read.' });
    } finally { setCheckingBounces(false); }
  };

  /** Saves first, so the test always runs against what is on screen. */
  const handleTestProvider = async (sendTo?: string) => {
    setTesting(true);
    setTestResult(null);
    try {
      if (!(await saveProvider())) return;
      const res = await api.post('/settings/email-provider/test', { to_email: sendTo || undefined });
      const data = res.data;
      if (data.success) {
        setTestResult({
          ok: true,
          message: data.stage === 'send'
            ? `Test email sent to ${sendTo} from ${data.from_email}. Check the inbox and the spam folder.`
            : 'Connected and signed in successfully.',
        });
      } else {
        setTestResult({ ok: false, message: data.error || 'The test failed.' });
      }
    } catch (err: any) {
      setTestResult({ ok: false, message: err.response?.data?.detail || 'The test could not be run.' });
    } finally { setTesting(false); }
  };

  const handleSaveIdentity = async () => {
    try {
      const payload = {
        ...identityForm,
        from_email: identityForm.from_email.trim(),
        from_name: identityForm.from_name.trim(),
        reply_to: identityForm.reply_to.trim() || identityForm.from_email.trim(),
      };
      if (editingIdentity) { await api.patch(`/sender-identities/${editingIdentity.public_code}`, payload); toast.success('Identity updated'); }
      else { await api.post('/sender-identities/', payload); toast.success('Identity created'); }
      setShowIdentityForm(false); setEditingIdentity(null);
      setIdentityForm({ from_email: '', from_name: '', reply_to: '', is_default: false });
      loadIdentities();
    } catch (err: any) { toast.error(err.response?.data?.detail || 'Failed to save identity'); }
  };

  const handleEditIdentity = (identity: SenderIdentity) => {
    setEditingIdentity(identity);
    setIdentityForm({ from_email: identity.from_email, from_name: identity.from_name, reply_to: identity.reply_to || '', is_default: identity.is_default });
    setShowIdentityForm(true);
  };

  const handleDeleteIdentity = async (code: string) => {
    try { await api.delete(`/sender-identities/${code}`); toast.success('Identity deleted'); loadIdentities(); }
    catch (err: any) { toast.error(err.response?.data?.detail || 'Failed to delete'); }
    finally { setDeleteIdentityCode(null); }
  };

  const handleToggleActive = async (identity: SenderIdentity) => {
    try { await api.patch(`/sender-identities/${identity.public_code}`, { is_active: !identity.is_active }); loadIdentities(); }
    catch { toast.error('Failed to update'); }
  };

  const handleSaveRetention = async () => {
    setSavingRetention(true);
    try {
      await api.post('/settings/data-retention', retention);
      toast.success('Data retention settings saved');
    } catch (err: any) { toast.error(err.response?.data?.detail || 'Failed to save'); }
    finally { setSavingRetention(false); }
  };

  const loadCampaignControls = async () => {
    try {
      const res = await api.get('/settings/campaign-mode');
      setCampaignMode(res.data.mode || 'global');
      setMaxRecipients(res.data.max_recipients || null);
      setAllowScheduling(res.data.allow_scheduling ?? true);
    } catch { /* defaults */ }
  };

  const handleSaveCampaignControls = async () => {
    setSavingCampaignControls(true);
    try {
      await api.post('/settings/campaign-mode', {
        mode: campaignMode,
        max_recipients: maxRecipients || null,
        allow_scheduling: allowScheduling,
      });
      toast.success('Campaign controls saved');
    } catch (err: any) { toast.error(err.response?.data?.detail || 'Failed to save'); }
    finally { setSavingCampaignControls(false); }
  };

  const tabs: { key: Tab; label: string; icon: React.ElementType }[] = [
    { key: 'general', label: 'General', icon: Globe },
    { key: 'identities', label: 'Sender Identities', icon: UserCircle },
    { key: 'campaign-controls', label: 'Campaign Controls', icon: Sliders },
    { key: 'provider', label: 'Email Provider', icon: Mail },
  ];

  return (
    <PageContainer className="space-y-6">
      <PageHeader title="Settings" subtitle="Branding, senders, campaign policy, and delivery configuration" />

      <SegmentedControl
        ariaLabel="Settings sections"
        size="md"
        className="w-full"
        value={tab}
        onChange={setTab}
        options={tabs.map(t => ({ value: t.key, label: t.label, icon: t.icon }))}
      />

      <AnimatePresence mode="wait">
        {/* ─── GENERAL SETTINGS ─── */}
        {tab === 'general' && (
          <motion.div key="general" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} className="space-y-5">
            <div>
              <h2 className="section-title">General Settings</h2>
              <p className="text-sm text-gray-500">Configure your application branding and preferences</p>
            </div>

            <div className="card-static p-5 space-y-4">
              <div>
                <label htmlFor="app-name" className="block text-sm font-medium text-gray-700 mb-1.5">Application Name</label>
                <input id="app-name" value={appName} onChange={e => setAppName(e.target.value)} className="input-field" placeholder={DEFAULT_APP_NAME} />
                <p className="text-xs text-gray-500 mt-1">Displayed in the sidebar, emails, and browser tab</p>
              </div>

              <div>
                <span className="block text-sm font-medium text-gray-700 mb-1.5">Logo</span>
                <div className="flex items-center gap-4">
                  {logoUrl && (
                    <div className="w-14 h-14 rounded-xl border border-gray-200 flex items-center justify-center overflow-hidden flex-shrink-0 bg-gray-50">
                      <img src={assetUrl(logoUrl)} alt="Current logo" className="w-full h-full object-contain" onError={e => (e.currentTarget.style.display = 'none')} />
                    </div>
                  )}
                  <label className="btn-secondary btn-sm inline-flex items-center gap-2">
                    <Upload size={14} /> {logoUrl ? 'Change' : 'Upload'}
                    <input type="file" accept="image/*" className="sr-only" onChange={e => { if (e.target.files?.[0]) handleFileUpload(e.target.files[0], setLogoUrl); }} />
                  </label>
                  {logoUrl && <button type="button" onClick={() => setLogoUrl('')} className="text-xs text-red-600 hover:text-red-700 cursor-pointer">Remove</button>}
                </div>
                <p className="text-xs text-gray-500 mt-1.5">Recommended: square image, at least 128×128px. Max 5MB</p>
              </div>

              <div>
                <span className="block text-sm font-medium text-gray-700 mb-1.5">Favicon</span>
                <div className="flex items-center gap-4">
                  {faviconUrl && (
                    <div className="w-10 h-10 rounded-lg border border-gray-200 flex items-center justify-center overflow-hidden flex-shrink-0 bg-gray-50">
                      <img src={assetUrl(faviconUrl)} alt="Current favicon" className="w-full h-full object-contain" onError={e => (e.currentTarget.style.display = 'none')} />
                    </div>
                  )}
                  <label className="btn-secondary btn-sm inline-flex items-center gap-2">
                    <Upload size={14} /> {faviconUrl ? 'Change' : 'Upload'}
                    <input type="file" accept="image/*,.ico" className="sr-only" onChange={e => { if (e.target.files?.[0]) handleFileUpload(e.target.files[0], setFaviconUrl); }} />
                  </label>
                  {faviconUrl && <button type="button" onClick={() => setFaviconUrl('')} className="text-xs text-red-600 hover:text-red-700 cursor-pointer">Remove</button>}
                </div>
                <p className="text-xs text-gray-500 mt-1.5">Shown in browser tabs. Use .ico, .png, or .svg. Max 5MB</p>
              </div>

              <div>
                <label htmlFor="timezone" className="block text-sm font-medium text-gray-700 mb-1.5">Timezone</label>
                <select id="timezone" value={timezone} onChange={e => setTimezone(e.target.value)} className="input-field">
                  {['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
                    'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Asia/Kolkata', 'Asia/Tokyo',
                    'Asia/Shanghai', 'Asia/Dubai', 'Australia/Sydney', 'Pacific/Auckland',
                  ].map(tz => <option key={tz} value={tz}>{tz.replace(/_/g, ' ')}</option>)}
                </select>
                <p className="text-xs text-gray-500 mt-1">Used for scheduling campaigns and displaying timestamps</p>
              </div>
            </div>

            {/* Application Theme */}
            <div className="card-static p-5 space-y-4">
              <div>
                <span className="block text-sm font-medium text-gray-700 mb-1.5">Application Theme</span>
                <p className="text-xs text-gray-500 mb-3">Choose a preset palette or pick a custom brand color</p>
              </div>
              <div className="grid grid-cols-4 sm:grid-cols-8 gap-3">
                {PALETTES.map(p => {
                  const isSelected = themePalette === p.name;
                  return (
                    <button
                      key={p.name}
                      type="button"
                      onClick={() => {
                        setThemePalette(p.name);
                        useThemeStore.getState().setPalette(p.name);
                      }}
                      className={`group flex flex-col items-center gap-1.5 p-2 rounded-xl transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                        isSelected ? 'bg-gray-100 ring-2 ring-gray-900 ring-offset-1' : 'hover:bg-gray-50'
                      }`}
                      title={p.label}
                      aria-pressed={isSelected}
                    >
                      <div className="relative">
                        <div
                          className="w-10 h-10 rounded-xl shadow-sm transition-transform group-hover:scale-110"
                          style={{ background: `linear-gradient(135deg, ${p.colors[500]}, ${p.colors[700]})` }}
                        />
                        {isSelected && (
                          <div className="absolute inset-0 flex items-center justify-center">
                            <Check size={16} className="text-white drop-shadow-md" />
                          </div>
                        )}
                      </div>
                      <span className={`text-[10px] font-medium ${isSelected ? 'text-gray-900' : 'text-gray-500'}`}>
                        {p.label}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className={`flex flex-col sm:flex-row sm:items-center gap-3 p-3 rounded-xl border transition-colors ${
                themePalette === 'custom' ? 'border-gray-900 bg-gray-50' : 'border-gray-200'
              }`}>
                <button
                  type="button"
                  onClick={() => {
                    setThemePalette('custom');
                    useThemeStore.getState().setPalette('custom', themeCustomPrimary);
                  }}
                  className="flex items-center gap-2 cursor-pointer"
                >
                  <div
                    className="w-10 h-10 rounded-xl shadow-sm border border-gray-200"
                    style={{ background: `linear-gradient(135deg, ${themeCustomPrimary}, ${generatePaletteFromPrimary(themeCustomPrimary)[700]})` }}
                  />
                  <div className="text-left">
                    <div className="text-sm font-medium text-gray-800">Custom color</div>
                    <div className="text-[11px] text-gray-500">Pick any brand primary</div>
                  </div>
                </button>
                <label className="flex items-center gap-2 sm:ml-auto cursor-pointer">
                  <span className="text-xs text-gray-500 font-mono">{themeCustomPrimary}</span>
                  <input
                    type="color"
                    value={themeCustomPrimary}
                    onChange={e => {
                      const hex = e.target.value;
                      setThemeCustomPrimary(hex);
                      setThemePalette('custom');
                      useThemeStore.getState().setPalette('custom', hex);
                    }}
                    className="w-10 h-10 rounded-lg border border-gray-200 cursor-pointer bg-transparent"
                    aria-label="Custom brand color"
                  />
                </label>
              </div>

              {/* Mini preview strip */}
              {(() => {
                const c = themePalette === 'custom'
                  ? generatePaletteFromPrimary(themeCustomPrimary)
                  : PALETTES.find(p => p.name === themePalette)?.colors;
                if (!c) return null;
                return (
                  <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-gray-100">
                    <span className="text-xs text-gray-500 mr-1">Preview:</span>
                    <div className="flex items-center gap-1">
                      {(['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'] as const).map(shade => (
                        <div key={shade} className="w-5 h-5 rounded" style={{ backgroundColor: c[shade] }} title={shade} />
                      ))}
                    </div>
                    <div className="ml-3 flex items-center gap-2">
                      <button type="button" className="px-3 py-1 text-[10px] font-semibold text-white rounded-lg" style={{ background: `linear-gradient(to right, ${c[600]}, ${c[500]})` }}>Button</button>
                      <span className="text-[10px] font-medium" style={{ color: c[600] }}>Link text</span>
                    </div>
                  </div>
                );
              })()}
            </div>

          </motion.div>
        )}

        {/* ─── SENDER IDENTITIES ─── */}
        {tab === 'identities' && (
          <motion.div key="identities" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="section-title">Sender Identities</h2>
                <p className="text-sm text-gray-500">Configure who emails come from</p>
              </div>
              <button type="button" onClick={() => { setShowIdentityForm(true); setEditingIdentity(null); setIdentityForm({ from_email: '', from_name: '', reply_to: '', is_default: false }); }}
                className="btn-primary btn-sm self-start sm:self-auto"><Plus size={15} /> Add Identity</button>
            </div>

            <AnimatePresence>
              {showIdentityForm && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                  <div className="card-static p-5 border-brand-200">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="font-semibold text-sm text-brand-800">{editingIdentity ? 'Edit Identity' : 'New Identity'}</h3>
                      <IconButton icon={X} label="Close identity form" size="sm" onClick={() => { setShowIdentityForm(false); setEditingIdentity(null); }} />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">From Email *</label>
                        <input type="email" value={identityForm.from_email} onChange={e => setIdentityForm({ ...identityForm, from_email: e.target.value })} className="input-field !py-2 text-sm" placeholder="noreply@company.com" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">From Name *</label>
                        <input value={identityForm.from_name} onChange={e => setIdentityForm({ ...identityForm, from_name: e.target.value })} className="input-field !py-2 text-sm" placeholder="Company Name" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">
                          Reply-To <span className="text-gray-400 font-normal">(Optional — defaults to From Email)</span>
                        </label>
                        <input
                          type="email"
                          value={identityForm.reply_to}
                          onChange={e => setIdentityForm({ ...identityForm, reply_to: e.target.value })}
                          className="input-field !py-2 text-sm"
                          placeholder={identityForm.from_email || "support@company.com"}
                        />
                      </div>
                      <div className="flex items-end pb-1">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input type="checkbox" checked={identityForm.is_default} onChange={e => setIdentityForm({ ...identityForm, is_default: e.target.checked })} className="w-4 h-4 text-brand-600 rounded" />
                          <span className="text-sm text-gray-700">Set as default</span>
                        </label>
                      </div>
                    </div>
                    <div className="flex gap-2 mt-4">
                      <button type="button" onClick={handleSaveIdentity} disabled={!identityForm.from_email || !identityForm.from_name} className="btn-primary btn-sm">
                        {editingIdentity ? 'Update' : 'Create'}
                      </button>
                      <button type="button" onClick={() => { setShowIdentityForm(false); setEditingIdentity(null); }} className="btn-ghost btn-sm">Cancel</button>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {loadingIdentities ? (
              <div className="space-y-2">{[1, 2].map(i => <div key={i} className="card-static p-4 flex gap-3"><div className="skeleton w-10 h-10 rounded-xl" /><div className="flex-1 space-y-2"><div className="skeleton h-4 w-40" /><div className="skeleton h-3 w-56" /></div></div>)}</div>
            ) : identities.length === 0 ? (
              <EmptyState
                compact
                icon={UserCircle}
                title="No sender identities yet"
                description="Add a from-address so campaigns know who they're sent from"
                action={
                  <button type="button" className="btn-primary btn-sm"
                    onClick={() => { setShowIdentityForm(true); setEditingIdentity(null); setIdentityForm({ from_email: '', from_name: '', reply_to: '', is_default: false }); }}>
                    <Plus size={15} /> Add Identity
                  </button>
                }
              />
            ) : (
              <div className="space-y-2">
                {identities.map(identity => (
                  <div key={identity.public_code} className={`card group p-4 flex items-center gap-4 ${!identity.is_active ? 'opacity-50' : ''}`}>
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent-400 to-brand-400 flex items-center justify-center text-white text-xs font-bold shadow-md flex-shrink-0">
                      {identity.from_name.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm text-gray-900 truncate">{identity.from_name}</span>
                        <span className="font-mono text-[11px] text-gray-500">{identity.public_code}</span>
                        {identity.is_default && <Star size={12} className="text-amber-500 fill-amber-500 flex-shrink-0" />}
                      </div>
                      <p className="text-xs text-gray-500 truncate">&lt;{identity.from_email}&gt;{identity.reply_to ? ` · Reply: ${identity.reply_to}` : ''}</p>
                    </div>
                    <span className={`badge ring-0 ${identity.is_active ? 'badge-success' : 'badge-gray'}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${identity.is_active ? 'bg-emerald-500' : 'bg-gray-400'}`} />
                      {identity.is_active ? 'Active' : 'Inactive'}
                    </span>
                    <div className="flex items-center gap-0.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                      <IconButton
                        icon={identity.is_active ? ToggleRight : ToggleLeft}
                        label={identity.is_active ? `Deactivate ${identity.from_name}` : `Activate ${identity.from_name}`}
                        tone={identity.is_active ? 'success' : 'default'}
                        size="sm"
                        className={identity.is_active ? 'text-emerald-500' : ''}
                        onClick={() => handleToggleActive(identity)}
                      />
                      <IconButton icon={Pencil} label={`Edit ${identity.from_name}`} tone="brand" size="sm" onClick={() => handleEditIdentity(identity)} />
                      <IconButton icon={Trash2} label={`Delete ${identity.from_name}`} tone="danger" size="sm" onClick={() => setDeleteIdentityCode(identity.public_code)} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </motion.div>
        )}

        {/* ─── EDITORS ─── */}
        {tab === 'campaign-controls' && (
          <motion.div key="campaign-controls" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} className="space-y-6">

            {/* Campaign Mode */}
            <div>
              <h2 className="section-title">Campaign Visibility</h2>
              <p className="text-sm text-gray-500">Control how campaigns are shared between users</p>
            </div>
            <div className="card-static p-5 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Visibility Mode</label>
                <div className="grid grid-cols-2 gap-3">
                  {(['global', 'user'] as const).map(mode => (
                    <button key={mode} type="button" onClick={() => setCampaignMode(mode)} aria-pressed={campaignMode === mode}
                      className={`p-4 rounded-xl border-2 text-left transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${campaignMode === mode ? 'border-brand-500 bg-brand-50/50' : 'border-gray-100 hover:border-gray-200'}`}>
                      <span className="font-semibold text-sm">{mode === 'global' ? 'Global' : 'User-Only'}</span>
                      <p className="text-xs text-gray-500 mt-0.5">{mode === 'global' ? 'All users see all campaigns' : 'Users only see their own campaigns'}</p>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Max Recipients per Campaign</label>
                <input type="number" value={maxRecipients || ''} onChange={e => setMaxRecipients(e.target.value ? parseInt(e.target.value) : null)} className="input-field" placeholder="Unlimited" />
                <p className="text-xs text-gray-500 mt-1">Leave empty for unlimited</p>
              </div>
              <Switch
                checked={allowScheduling}
                onChange={setAllowScheduling}
                label="Allow Scheduling"
                description="Let users schedule campaigns for later"
              />
            </div>

            {/* Data Retention */}
            <div>
              <h2 className="section-title flex items-center gap-2"><Shield size={16} /> Data Retention</h2>
              <p className="text-sm text-gray-500">Automatically clean up old data based on retention policies</p>
            </div>
            <div className="card-static p-5 space-y-5">
              {/* Master Toggle */}
              <Switch
                checked={retention.enabled}
                onChange={enabled => setRetention({ ...retention, enabled })}
                label="Enable Data Retention"
                description="Automatically delete old records on a schedule"
              />

              {retention.enabled && (
                <div className="space-y-4 pt-2 border-t border-gray-100">
                  {/* Campaign Retention */}
                  <div className="p-4 bg-gray-50 rounded-xl space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-sm font-medium text-gray-700">Campaigns</span>
                        <p className="text-xs text-gray-500">Delete completed/failed campaigns after N days</p>
                      </div>
                      <input
                        type="number" min={1} placeholder="Days"
                        value={retention.campaign_retention_days ?? ''}
                        onChange={e => setRetention({ ...retention, campaign_retention_days: e.target.value ? parseInt(e.target.value) : null })}
                        className="input-field w-24 text-center !py-1.5 text-sm"
                      />
                    </div>
                    {retention.campaign_retention_days && (
                      <div className="pl-4 border-l-2 border-gray-200">
                        <span className="text-xs font-medium text-gray-600 mb-1.5 block">When deleting campaigns:</span>
                        <div className="space-y-1.5">
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input type="radio" name="campaign_del_recip" checked={retention.campaign_delete_recipients}
                              onChange={() => setRetention({ ...retention, campaign_delete_recipients: true })}
                              className="w-3.5 h-3.5 text-brand-600" />
                            <span className="text-xs text-gray-600">Also remove associated recipients</span>
                          </label>
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input type="radio" name="campaign_del_recip" checked={!retention.campaign_delete_recipients}
                              onChange={() => setRetention({ ...retention, campaign_delete_recipients: false })}
                              className="w-3.5 h-3.5 text-brand-600" />
                            <span className="text-xs text-gray-600">Keep recipients (only remove campaign shell)</span>
                          </label>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Recipients PII Retention */}
                  <div className="p-4 bg-gray-50 rounded-xl">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-sm font-medium text-gray-700">Recipient Data</span>
                        <p className="text-xs text-gray-500">Delete sent recipient records after N days</p>
                      </div>
                      <input
                        type="number" min={1} placeholder="Days"
                        value={retention.recipient_retention_days ?? ''}
                        onChange={e => setRetention({ ...retention, recipient_retention_days: e.target.value ? parseInt(e.target.value) : null })}
                        className="input-field w-24 text-center !py-1.5 text-sm"
                      />
                    </div>
                  </div>

                  {/* Tracking Events Retention */}
                  <div className="p-4 bg-gray-50 rounded-xl">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-sm font-medium text-gray-700">Tracking Events</span>
                        <p className="text-xs text-gray-500">Delete open/click tracking data after N days</p>
                      </div>
                      <input
                        type="number" min={1} placeholder="Days"
                        value={retention.tracking_retention_days ?? ''}
                        onChange={e => setRetention({ ...retention, tracking_retention_days: e.target.value ? parseInt(e.target.value) : null })}
                        className="input-field w-24 text-center !py-1.5 text-sm"
                      />
                    </div>
                  </div>

                  {/* Upload History Retention */}
                  <div className="p-4 bg-gray-50 rounded-xl">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-sm font-medium text-gray-700">Upload History</span>
                        <p className="text-xs text-gray-500">Delete upload job records &amp; files after N days</p>
                      </div>
                      <input
                        type="number" min={1} placeholder="Days"
                        value={retention.upload_retention_days ?? ''}
                        onChange={e => setRetention({ ...retention, upload_retention_days: e.target.value ? parseInt(e.target.value) : null })}
                        className="input-field w-24 text-center !py-1.5 text-sm"
                      />
                    </div>
                  </div>

                  {/* Suppression exempt note */}
                  <div className="flex items-start gap-2 p-3 bg-amber-50 rounded-lg border border-amber-100">
                    <Shield size={14} className="text-amber-500 flex-shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-700">
                      <strong>Note:</strong> The suppression list is never affected by retention policies. Suppressed emails remain permanently to prevent accidental re-sends.
                    </p>
                  </div>

                  {/* All active retention summary */}
                  {(retention.campaign_retention_days || retention.recipient_retention_days || retention.tracking_retention_days || retention.upload_retention_days) && (
                    <div className="p-3 bg-blue-50 rounded-lg border border-blue-100">
                      <span className="text-xs font-medium text-blue-700 block mb-1">Active Retention Policies:</span>
                      <ul className="text-xs text-blue-600 space-y-0.5">
                        {retention.campaign_retention_days && <li>• Campaigns: {retention.campaign_retention_days} days {retention.campaign_delete_recipients ? '(with recipients)' : '(shell only)'}</li>}
                        {retention.recipient_retention_days && <li>• Recipients: {retention.recipient_retention_days} days</li>}
                        {retention.tracking_retention_days && <li>• Tracking events: {retention.tracking_retention_days} days</li>}
                        {retention.upload_retention_days && <li>• Upload history: {retention.upload_retention_days} days</li>}
                      </ul>
                    </div>
                  )}
                </div>
              )}

            </div>
          </motion.div>
        )}

        {/* ─── EMAIL PROVIDER ─── */}
        {tab === 'provider' && (
          <motion.div key="provider" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} className="space-y-5">
            {/* Provider Selection */}
            <div className="card-static p-5">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-brand-500 to-accent-500 flex items-center justify-center"><Mail size={16} className="text-white" /></div>
                <div><h3 className="font-semibold text-sm">Email Provider</h3><p className="text-xs text-gray-500">Choose how to send emails</p></div>
              </div>
              <div className="grid grid-cols-2 gap-3 mb-4">
                {(['ses', 'smtp'] as const).map(p => (
                  <button key={p} type="button" onClick={() => setProvider(p)} aria-pressed={provider === p}
                    className={`p-4 rounded-xl border-2 text-left transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${provider === p ? 'border-brand-500 bg-brand-50/50' : 'border-gray-100 hover:border-gray-200'}`}>
                    <span className="font-semibold text-sm">{p === 'ses' ? 'Amazon SES' : 'SMTP Server'}</span>
                    <p className="text-xs text-gray-500 mt-0.5">{p === 'ses' ? 'Scalable cloud email' : 'Custom mail server'}</p>
                  </button>
                ))}
              </div>
              {provider === 'ses' && (
                <Switch
                  checked={sandboxMode}
                  onChange={setSandboxMode}
                  label="Sandbox Mode"
                  description="Only send to verified emails"
                  tone="bg-amber-500"
                />
              )}
              {providerInfo.problem && (
                <p role="alert" className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2">
                  {providerInfo.problem}
                </p>
              )}
            </div>

            {/* SES Config */}
            {provider === 'ses' && (
              <div className="card-static p-5">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-orange-400 to-amber-500 flex items-center justify-center"><Server size={16} className="text-white" /></div>
                  <h3 className="font-semibold text-sm">Amazon SES Configuration</h3>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="sm:col-span-2">
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">AWS Region</label>
                    <input value={sesRegion} onChange={e => setSesRegion(e.target.value)} className="input-field w-full sm:w-1/2" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">Access Key ID</label>
                    <input value={sesAccessKey} onChange={e => setSesAccessKey(e.target.value)} className="input-field" placeholder="Leave blank to keep current" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">Secret Access Key</label>
                    <input type="password" value={sesSecretKey} onChange={e => setSesSecretKey(e.target.value)} className="input-field" placeholder="Leave blank to keep current" />
                  </div>
                </div>
              </div>
            )}

            {/* SMTP Config */}
            {provider === 'smtp' && (
              <div className="card-static p-5">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-400 to-cyan-500 flex items-center justify-center"><Server size={16} className="text-white" /></div>
                  <h3 className="font-semibold text-sm">SMTP Configuration</h3>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">Host</label>
                    <input value={smtpHost} onChange={e => setSmtpHost(e.target.value)} className="input-field" placeholder="smtp.gmail.com" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">Port</label>
                    <input type="number" value={smtpPort} onChange={e => setSmtpPort(Number(e.target.value))} className="input-field" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">Username</label>
                    <input value={smtpUsername} onChange={e => setSmtpUsername(e.target.value)} className="input-field" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">Password</label>
                    <input
                      type="password" value={smtpPassword} onChange={e => setSmtpPassword(e.target.value)}
                      className="input-field" autoComplete="new-password"
                      placeholder={providerInfo.smtpPasswordSet ? 'Saved. Leave blank to keep it' : 'Password or app password'}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <Switch
                      checked={smtpUseTls} onChange={setSmtpUseTls} label="Use TLS"
                      description={smtpPort === 465
                        ? 'Port 465: encrypted from the start (SSL/TLS)'
                        : 'Upgrades the connection with STARTTLS. Usual for port 587'}
                    />
                  </div>
                </div>
                <p className="text-xs text-gray-500 mt-3">
                  Gmail and Outlook need an app password, not your normal password. The From address of your
                  campaigns must be one this account is allowed to send as.
                </p>
              </div>
            )}

            {/* Test */}
            <div className="card-static p-5">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-brand-500 to-accent-500 flex items-center justify-center"><Mail size={16} className="text-white" /></div>
                <div>
                  <h3 className="font-semibold text-sm">Test these settings</h3>
                  <p className="text-xs text-gray-500">Saves what is on screen, then tries it for real</p>
                </div>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <div className="flex-1 min-w-[220px]">
                  <label htmlFor="provider-test-email" className="block text-sm font-medium text-gray-700 mb-1.5">Send a test email to</label>
                  <input
                    id="provider-test-email" type="email" value={testEmail}
                    onChange={e => setTestEmail(e.target.value)} className="input-field" placeholder="you@example.com"
                  />
                </div>
                <button
                  type="button" className="btn-primary" disabled={testing || !testEmail.includes('@')}
                  onClick={() => handleTestProvider(testEmail.trim())}
                >
                  {testing ? <Loader2 size={15} className="animate-spin" /> : <Mail size={15} />} Send test email
                </button>
                {provider === 'smtp' && (
                  <button type="button" className="btn-secondary" disabled={testing} onClick={() => handleTestProvider()}>
                    Test connection only
                  </button>
                )}
              </div>
              {testResult && (
                <p
                  role="status"
                  className={`mt-3 text-sm rounded-xl px-3 py-2 border break-words ${
                    testResult.ok ? 'text-emerald-800 bg-emerald-50 border-emerald-200' : 'text-red-700 bg-red-50 border-red-200'
                  }`}
                >
                  {testResult.message}
                </p>
              )}
            </div>

            {/* Bounce detection */}
            {provider === 'smtp' && (
              <div className="card-static p-5">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-red-400 to-rose-500 flex items-center justify-center"><Mail size={16} className="text-white" /></div>
                  <div>
                    <h3 className="font-semibold text-sm">Bounce detection</h3>
                    <p className="text-xs text-gray-500">Reads the sender mailbox for "could not be delivered" replies</p>
                  </div>
                </div>
                <Switch
                  checked={imapEnabled} onChange={setImapEnabled} label="Check the mailbox for bounces"
                  description={`Every ${bounceMailbox?.check_every_seconds ?? 60} seconds. Read-only: nothing is deleted, moved or marked as read.`}
                />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
                  <div>
                    <label htmlFor="imap-host" className="block text-sm font-medium text-gray-700 mb-1.5">IMAP host</label>
                    <input id="imap-host" value={imapHost} onChange={e => setImapHost(e.target.value)} className="input-field"
                      placeholder={bounceMailbox?.host ? `${bounceMailbox.host} (automatic)` : 'imap.gmail.com'} />
                  </div>
                  <div>
                    <label htmlFor="imap-port" className="block text-sm font-medium text-gray-700 mb-1.5">Port</label>
                    <input id="imap-port" type="number" value={imapPort} onChange={e => setImapPort(Number(e.target.value))} className="input-field" />
                  </div>
                  <div>
                    <label htmlFor="imap-username" className="block text-sm font-medium text-gray-700 mb-1.5">Username</label>
                    <input id="imap-username" value={imapUsername} onChange={e => setImapUsername(e.target.value)} className="input-field"
                      placeholder="Same as SMTP" autoComplete="off" />
                  </div>
                  <div>
                    <label htmlFor="imap-password" className="block text-sm font-medium text-gray-700 mb-1.5">Password</label>
                    <input id="imap-password" type="password" value={imapPassword} onChange={e => setImapPassword(e.target.value)}
                      className="input-field" autoComplete="new-password"
                      placeholder={providerInfo.imapPasswordSet ? 'Saved. Leave blank to keep it' : 'Same as SMTP'} />
                  </div>
                  <div>
                    <label htmlFor="imap-folder" className="block text-sm font-medium text-gray-700 mb-1.5">Folder</label>
                    <input id="imap-folder" value={imapFolder} onChange={e => setImapFolder(e.target.value)} className="input-field" />
                  </div>
                </div>
                <p className="text-xs text-gray-500 mt-3">
                  Leave the fields blank to use the SMTP account. Bounces go to the address your campaigns are sent
                  from, so this must be that mailbox. Most bounces arrive within a few minutes of sending; some
                  servers keep trying for days first.
                </p>
                <div className="flex flex-wrap items-center gap-3 mt-4">
                  <button type="button" className="btn-secondary" disabled={checkingBounces} onClick={handleCheckBounces}>
                    {checkingBounces ? <Loader2 size={15} className="animate-spin" /> : <Mail size={15} />} Save and check now
                  </button>
                  {bounceMailbox && (
                    <span className="text-xs text-gray-500">
                      {bounceMailbox.last_success_at
                        ? `Last read ${new Date(bounceMailbox.last_success_at).toLocaleString()}`
                        : 'Not read yet'}
                      {` · ${bounceMailbox.total_marked.toLocaleString()} bounced so far`}
                    </span>
                  )}
                </div>
                {(bounceResult || bounceMailbox?.last_error) && (
                  <p
                    role="status"
                    className={`mt-3 text-sm rounded-xl px-3 py-2 border break-words ${
                      bounceResult?.ok ? 'text-emerald-800 bg-emerald-50 border-emerald-200' : 'text-red-700 bg-red-50 border-red-200'
                    }`}
                  >
                    {bounceResult?.message || bounceMailbox?.last_error}
                  </p>
                )}
              </div>
            )}

            {/* Tracking */}
            <div className="card-static p-5">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-400 to-cyan-500 flex items-center justify-center"><Server size={16} className="text-white" /></div>
                <div>
                  <h3 className="font-semibold text-sm">Open and click tracking</h3>
                  <p className="text-xs text-gray-500">
                    {providerInfo.trackingActive ? 'On: links and opens are tracked' : 'Off: emails are sent with their original links'}
                  </p>
                </div>
              </div>
              <label htmlFor="tracking-base-url" className="block text-sm font-medium text-gray-700 mb-1.5">Public address of this server</label>
              <input
                id="tracking-base-url" value={trackingBaseUrl} onChange={e => setTrackingBaseUrl(e.target.value)}
                className="input-field" placeholder="https://mail.yourdomain.com"
              />
              <p className="text-xs text-gray-500 mt-2">
                Tracked links and the unsubscribe link point here, so recipients must be able to reach it from the
                internet.
                {!providerInfo.trackingUrlIsPublic && ' It is a local address now, so tracking and the unsubscribe link are left out to keep the links in your emails working.'}
              </p>
            </div>

            {/* Rate Limiting & Sending Speed */}
            <div className="card-static p-5">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-400 to-teal-500 flex items-center justify-center">
                  <Gauge size={16} className="text-white" />
                </div>
                <div>
                  <h3 className="font-semibold text-sm">Rate Limiting & Sending Speed</h3>
                  <p className="text-xs text-gray-500">Control delays between sent emails or throughput limit</p>
                </div>
              </div>

              {/* Mode Selection */}
              <div className="space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center gap-3 p-3 bg-gray-50 rounded-xl border border-gray-100">
                  <label className="flex items-center gap-2 cursor-pointer text-sm font-medium text-gray-800">
                    <input
                      type="radio"
                      name="rateLimitType"
                      checked={rateLimitType === 'delay'}
                      onChange={() => setRateLimitType('delay')}
                      className="w-4 h-4 text-brand-600 focus:ring-brand-500"
                    />
                    <span>Delay between emails (Recommended for SMTP)</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer text-sm font-medium text-gray-800">
                    <input
                      type="radio"
                      name="rateLimitType"
                      checked={rateLimitType === 'per_second'}
                      onChange={() => setRateLimitType('per_second')}
                      className="w-4 h-4 text-brand-600 focus:ring-brand-500"
                    />
                    <span>Emails per second (SES / High throughput)</span>
                  </label>
                </div>

                {rateLimitType === 'delay' ? (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">
                      Send 1 email every:
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        value={sendDelaySeconds}
                        onChange={e => setSendDelaySeconds(Math.max(1, Number(e.target.value)))}
                        className="input-field w-32 font-bold text-gray-900"
                        min={1}
                        max={3600}
                      />
                      <span className="text-sm font-medium text-gray-600">seconds</span>
                    </div>

                    {/* Presets */}
                    <div className="flex flex-wrap items-center gap-2 mt-2.5">
                      <span className="text-xs text-gray-400">Quick presets:</span>
                      {[
                        { label: '30 seconds', val: 30 },
                        { label: '60 seconds (1 min)', val: 60 },
                        { label: '80 seconds', val: 80 },
                        { label: '120 seconds (2 min)', val: 120 },
                      ].map(p => (
                        <button
                          key={p.val}
                          type="button"
                          onClick={() => setSendDelaySeconds(p.val)}
                          className={`px-2.5 py-1 text-xs rounded-lg border transition ${
                            sendDelaySeconds === p.val
                              ? 'bg-brand-50 border-brand-500 text-brand-700 font-semibold'
                              : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                          }`}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>

                    <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg p-2.5 mt-3">
                      ⚡ <strong>Sending Pace:</strong> 1 email every {sendDelaySeconds} seconds (~{Math.round((3600 / sendDelaySeconds) * 10) / 10} emails/hour). Spaced sending protects your sender reputation and prevents SMTP account suspension.
                    </p>
                  </div>
                ) : (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">Max Emails Per Second</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        value={maxSendRate}
                        onChange={e => setMaxSendRate(Number(e.target.value))}
                        className="input-field w-32 font-bold text-gray-900"
                        min={1}
                        max={100}
                      />
                      <span className="text-sm font-medium text-gray-600">emails/sec</span>
                    </div>
                    <p className="text-xs text-gray-500 mt-2">SES default limit is 14/sec. System auto-detects and uses the lower value.</p>
                  </div>
                )}
              </div>
            </div>

          </motion.div>
        )}
      </AnimatePresence>

      {tab !== 'identities' && (
        <div className="pt-2">
          <StickyActionBar
            sticky
            center={<span className="text-xs text-gray-500">Changes apply immediately after saving</span>}
            right={
              tab === 'general' ? (
                <button type="button" onClick={handleSaveGeneral} disabled={savingGeneral} className="btn-primary">
                  {savingGeneral ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                  {savingGeneral ? 'Saving…' : 'Save General Settings'}
                </button>
              ) : tab === 'campaign-controls' ? (
                <>
                  <button type="button" onClick={handleSaveCampaignControls} disabled={savingCampaignControls} className="btn-secondary">
                    {savingCampaignControls ? <Loader2 size={15} className="animate-spin" /> : <Sliders size={15} />}
                    {savingCampaignControls ? 'Saving…' : 'Save Campaign Settings'}
                  </button>
                  <button type="button" onClick={handleSaveRetention} disabled={savingRetention} className="btn-primary">
                    {savingRetention ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                    {savingRetention ? 'Saving…' : 'Save Retention Settings'}
                  </button>
                </>
              ) : (
                <button type="button" onClick={handleSave} disabled={saving} className="btn-primary">
                  {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                  {saving ? 'Saving…' : 'Save Email Settings'}
                </button>
              )
            }
          />
        </div>
      )}

      <ConfirmDialog
        open={deleteIdentityCode !== null}
        title="Delete Identity"
        message="Are you sure you want to delete this sender identity? This cannot be undone."
        confirmLabel="Delete"
        onConfirm={() => deleteIdentityCode && handleDeleteIdentity(deleteIdentityCode)}
        onCancel={() => setDeleteIdentityCode(null)}
      />
    </PageContainer>
  );
}
