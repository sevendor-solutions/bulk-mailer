import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import api from '../services/api';
import toast from 'react-hot-toast';
import FileUpload from '../components/FileUpload';
import ColumnMapper from '../components/ColumnMapper';
import MergeFieldManager from '../components/MergeFieldManager';
import type { MergeFieldDef } from '../components/MergeFieldManager';
import EditorSelector from '../components/EditorSelector';
import PreviewPane from '../editors/PreviewPane';
import WizardShell from '../components/WizardShell';
import WizardActionBar from '../components/WizardActionBar';
import RecipientTable from '../components/RecipientTable';
import type {
  ColumnMapping, ThemeConfig, UploadResponse, UploadStatus,
  SenderIdentity,
  CampaignListItem,
  MergeFieldDefinition,
  Template,
  EditorType,
} from '../types';
import {
  ArrowLeft, ArrowRight, Clock, Check,
  AlertCircle, Loader2, Rocket, CalendarClock, Upload, Users, Search,
  PanelsTopLeft, PenLine, LayoutTemplate, Save, FileText, Plus
} from 'lucide-react';

const STEPS = ['Details', 'Recipients', 'Map Columns', 'Compose', 'Review & Send'];

const slideVariants = {
  enter: (dir: number) => ({ x: dir > 0 ? 40 : -40, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({ x: dir > 0 ? -40 : 40, opacity: 0 }),
};

export default function CampaignWizard() {
  const navigate = useNavigate();
  const { id: editId } = useParams<{ id: string }>();
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState(1);
  const [highestStepReached, setHighestStepReached] = useState(0);
  const [loading, setLoading] = useState(false);
  const [recipientMode, setRecipientMode] = useState<'choose' | 'upload' | 'import' | 'review'>('choose');
  const [includedCount, setIncludedCount] = useState(0);
  const [recipientTotal, setRecipientTotal] = useState(0);
  const [hasRecipients, setHasRecipients] = useState(false);

  // Step 1: Details
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [preheader, setPreheader] = useState('');
  const [senderIdentities, setSenderIdentities] = useState<SenderIdentity[]>([]);
  const [selectedIdentityId, setSelectedIdentityId] = useState<number | null>(null);
  const [customFromName, setCustomFromName] = useState('');
  const [useCustomName, setUseCustomName] = useState(false);
  const [customReplyTo, setCustomReplyTo] = useState('');
  const [useCustomReplyTo, setUseCustomReplyTo] = useState(false);
  const [loadingIdentities, setLoadingIdentities] = useState(true);

  // Step 2: Upload
  const [campaignCode, setCampaignCode] = useState<string | null>(null);
  const [uploadResult, setUploadResult] = useState<UploadResponse | null>(null);
  const [uploadStatus, setUploadStatus] = useState<UploadStatus | null>(null);

  // Step 3: Column Mapping + Merge Fields
  const [columnMapping, setColumnMapping] = useState<ColumnMapping>({ email_column: '' });
  const [mergeFields, setMergeFields] = useState<MergeFieldDef[]>([]);

  // Step 4: Compose — inline compose or select from templates
  const [htmlBody, setHtmlBody] = useState('');
  const [themeConfig, setThemeConfig] = useState<ThemeConfig | null>(null);
  const [contentStatus, setContentStatus] = useState<'published' | 'draft' | null>(null);
  const [editorType, setEditorType] = useState<EditorType>('custom');
  const [contentJson, setContentJson] = useState('');
  const [composeTab, setComposeTab] = useState<'compose' | 'template'>('compose');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [templateSearch, setTemplateSearch] = useState('');
  const [savingContent, setSavingContent] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<number | null>(null);

  // Step 5: Schedule
  const [scheduleAt, setScheduleAt] = useState('');

  useEffect(() => { loadSenderIdentities(); }, []);

  // Load existing campaign for editing — hydrate recipients + upload job
  useEffect(() => {
    if (!editId) return;
    (async () => {
      try {
        const res = await api.get(`/campaigns/${editId}`);
        const c = res.data;
        const code = c.public_code as string;
        setCampaignCode(code);
        setName(c.name);
        setSubject(c.subject);
        if (c.preheader) setPreheader(c.preheader);
        if (c.sender_identity_id) setSelectedIdentityId(c.sender_identity_id);
        if (c.from_name) { setCustomFromName(c.from_name); setUseCustomName(true); }
        if (c.reply_to) { setCustomReplyTo(c.reply_to); setUseCustomReplyTo(true); }
        if (c.html_body) {
          setHtmlBody(c.html_body);
          setContentStatus('published');
        }
        if (c.theme_config) setThemeConfig(c.theme_config);
        if (c.merge_fields_config) setMergeFields(c.merge_fields_config);
        if (c.editor_type) setEditorType(c.editor_type as EditorType);
        if (c.content_json) setContentJson(c.content_json);
        if (c.selected_template_id) setSelectedTemplateId(c.selected_template_id);

        try {
          const target = await api.get(`/composer/targets/campaign/${code}`);
          if (target.data?.status === 'published' || c.html_body) {
            setContentStatus('published');
          } else {
            setContentStatus('draft');
          }
        } catch {
          if (c.html_body) setContentStatus('published');
          else setContentStatus(null);
        }

        let recipientsOk = (c.total_recipients || 0) > 0;
        try {
          const sum = await api.get(`/campaigns/${code}/recipients/summary`);
          setIncludedCount(sum.data.included ?? 0);
          setRecipientTotal(sum.data.total ?? 0);
          recipientsOk = (sum.data.total ?? 0) > 0;
          setHasRecipients(recipientsOk);
          if (recipientsOk) setRecipientMode('review');
        } catch { /* ignore */ }

        try {
          const latest = await api.get(`/campaigns/${code}/upload/latest`);
          if (latest.data) {
            const job = latest.data;
            setUploadResult({
              job_id: job.job_id,
              filename: job.filename,
              total_rows: job.total_rows,
              columns: job.columns || [],
            });
            if (job.column_mapping) {
              setColumnMapping({
                email_column: job.column_mapping.email_column || '',
                name_column: job.column_mapping.name_column,
                merge_fields: job.column_mapping.merge_fields,
              });
            }
            setUploadStatus({
              job_id: job.job_id,
              status: job.status,
              total_rows: job.total_rows,
              processed_rows: job.total_rows,
              valid_rows: job.valid_rows,
              invalid_rows: job.invalid_rows,
              duplicate_rows: job.duplicate_rows,
              suppressed_rows: job.suppressed_rows,
            });
          }
        } catch { /* ignore */ }

        const hasContent = !!(c.html_body && String(c.html_body).trim());
        const landing = recipientsOk ? 3 : 1;
        setHighestStepReached(hasContent ? 4 : recipientsOk ? 3 : 1);
        setStep(landing);
      } catch {
        toast.error('Failed to load campaign');
        navigate('/');
      }
    })();
  }, [editId, navigate]);

  const goStep = (s: number) => {
    setDirection(s > step ? 1 : -1);
    setStep(s);
    setHighestStepReached(h => Math.max(h, s));
  };

  const campaignMergeFields: MergeFieldDefinition[] = useMemo(() => {
    const list: MergeFieldDefinition[] = [
      { key: 'email', label: 'Email', data_type: 'email', required: true, is_system: true, source_kind: 'system', default_value: null, source_column: null },
      { key: 'first_name', label: 'First Name', data_type: 'text', required: false, is_system: true, source_kind: 'system', default_value: null, source_column: null },
      { key: 'last_name', label: 'Last Name', data_type: 'text', required: false, is_system: true, source_kind: 'system', default_value: null, source_column: null },
      { key: 'name', label: 'Full Name', data_type: 'text', required: false, is_system: true, source_kind: 'system', default_value: null, source_column: null },
    ];
    if (mergeFields?.length) {
      mergeFields.forEach(f => {
        if (!list.some(item => item.key === f.name)) {
          list.push({
            key: f.name,
            label: f.label || f.name,
            data_type: 'text',
            required: false,
            default_value: f.defaultValue || null,
            source_kind: f.source === 'csv' ? 'uploaded_column' : 'custom',
            source_column: f.source === 'csv' ? f.name : null,
            is_system: false,
          });
        }
      });
    }
    return list;
  }, [mergeFields]);

  const loadTemplates = async () => {
    setLoadingTemplates(true);
    try {
      const res = await api.get('/templates/');
      setTemplates(res.data);
    } catch {
      toast.error('Failed to load templates');
    } finally {
      setLoadingTemplates(false);
    }
  };

  useEffect(() => {
    if (step === 3 && templates.length === 0) {
      loadTemplates();
    }
  }, [step, templates.length]);

  const handleSelectTemplate = async (template: Template) => {
    const html = template.html_output || '';
    setHtmlBody(html);
    if (template.theme_config) {
      try {
        setThemeConfig(JSON.parse(template.theme_config));
      } catch { /* ignore */ }
    }
    setSelectedTemplateId(template.id || null);
    if (template.editor_type) {
      setEditorType(template.editor_type as EditorType);
    }
    if (template.content_json) {
      setContentJson(template.content_json);
    }

    if (campaignCode) {
      setSavingContent(true);
      try {
        await api.patch(`/campaigns/${campaignCode}`, {
          html_body: html,
          selected_template_id: template.id,
          editor_type: template.editor_type || 'custom',
          content_json: template.content_json || undefined,
          theme_config: template.theme_config ? JSON.parse(template.theme_config) : undefined,
        });
        setContentStatus('published');
        toast.success(`Template "${template.name}" applied!`);
        setComposeTab('compose');
      } catch (err: any) {
        toast.error(err.response?.data?.detail || 'Failed to apply template to campaign');
      } finally {
        setSavingContent(false);
      }
    } else {
      setContentStatus('published');
      setComposeTab('compose');
    }
  };

  const handleSaveContent = async (silent = false) => {
    if (!campaignCode) return;
    try {
      if (!silent) setSavingContent(true);
      await api.patch(`/campaigns/${campaignCode}`, {
        html_body: htmlBody,
        subject,
        preheader: preheader || undefined,
        editor_type: editorType,
        content_json: contentJson || undefined,
        theme_config: themeConfig || undefined,
        selected_template_id: selectedTemplateId || undefined,
      });
      setContentStatus('published');
      if (!silent) toast.success('Email draft saved!');
    } catch (err: any) {
      if (!silent) toast.error(err.response?.data?.detail || 'Failed to save email');
    } finally {
      if (!silent) setSavingContent(false);
    }
  };

  const filteredTemplates = templates.filter(t => {
    if (!templateSearch.trim()) return true;
    const q = templateSearch.toLowerCase();
    return (t.name && t.name.toLowerCase().includes(q)) ||
           (t.description && t.description.toLowerCase().includes(q));
  });

  const loadSenderIdentities = async () => {
    setLoadingIdentities(true);
    try {
      const res = await api.get('/sender-identities/');
      setSenderIdentities(res.data);
      const defaultId = res.data.find((i: SenderIdentity) => i.is_default);
      if (defaultId) setSelectedIdentityId(defaultId.id);
    } catch { /* no identities */ } finally { setLoadingIdentities(false); }
  };

  const selectedIdentity = senderIdentities.find(i => i.id === selectedIdentityId);

  const handleCreateCampaign = async () => {
    if (!name || !subject || !selectedIdentity) {
      toast.error('Please fill all required fields and select a sender');
      return;
    }
    setLoading(true);
    try {
      const defaultReplyTo = (selectedIdentity.reply_to || selectedIdentity.from_email || '').trim();
      const finalReplyTo = useCustomReplyTo && customReplyTo.trim() ? customReplyTo.trim() : defaultReplyTo;

      const payload = {
        name, subject, preheader: preheader || undefined,
        from_email: selectedIdentity.from_email,
        from_name: useCustomName ? customFromName : selectedIdentity.from_name,
        reply_to: finalReplyTo || undefined,
        sender_identity_id: selectedIdentity.id,
      };

      if (campaignCode) {
        // Update existing campaign
        await api.patch(`/campaigns/${campaignCode}`, payload);
      } else {
        // Create new campaign, then move the URL onto its edit route so the
        // campaign id is never only held in local state — leaving for the
        // composer and coming back (or a page refresh) must not lose it.
        const res = await api.post('/campaigns/', payload);
        setCampaignCode(res.data.public_code);
        navigate(`/campaigns/${res.data.public_code}/edit`, { replace: true });
      }
      goStep(1);
    } catch (err: any) {
      toast.error(err.response?.data?.detail || 'Failed to save campaign');
    } finally { setLoading(false); }
  };

  const handleUploadComplete = (result: UploadResponse) => {
    setUploadResult(result);
    goStep(2);
  };

  const refreshRecipientCounts = async (code: string) => {
    try {
      const sum = await api.get(`/campaigns/${code}/recipients/summary`);
      setIncludedCount(sum.data.included ?? 0);
      setRecipientTotal(sum.data.total ?? 0);
      setHasRecipients((sum.data.total ?? 0) > 0);
    } catch { /* ignore */ }
  };

  const handleMappingComplete = async () => {
    if (!campaignCode) return;
    // Already processed — skip reprocess
    if (!uploadResult || (hasRecipients && uploadStatus?.status === 'completed' && !columnMapping.email_column)) {
      setRecipientMode('review');
      goStep(1);
      return;
    }
    if (!uploadResult || !columnMapping.email_column) {
      toast.error('Map an email column to continue');
      return;
    }
    setLoading(true);
    try {
      const csvMergeFields: Record<string, string> = {};
      mergeFields.filter(f => f.source === 'csv').forEach(f => {
        csvMergeFields[f.name] = f.label;
      });

      const mappingPayload = {
        ...columnMapping,
        merge_fields: Object.keys(csvMergeFields).length > 0 ? csvMergeFields : undefined,
      };

      const res = await api.post(`/campaigns/${campaignCode}/upload/${uploadResult.job_id}/map`, mappingPayload);
      setUploadStatus(res.data);
      const pollInterval = setInterval(async () => {
        const statusRes = await api.get(`/campaigns/${campaignCode}/upload/${uploadResult.job_id}/status`);
        setUploadStatus(statusRes.data);
        if (statusRes.data.status === 'completed' || statusRes.data.status === 'failed') {
          clearInterval(pollInterval);
          if (statusRes.data.status === 'completed') {
            toast.success(`${statusRes.data.valid_rows} valid recipients processed`);
            await refreshRecipientCounts(campaignCode);
            setRecipientMode('review');
            goStep(1);
          } else { toast.error('Upload processing failed'); }
        }
      }, 1000);
    } catch (err: any) {
      toast.error(err.response?.data?.detail || 'Failed to process mapping');
    } finally { setLoading(false); }
  };

  const handleSend = async () => {
    if (!campaignCode) return;
    setLoading(true);
    try {
      // The picker gives local time without an offset; send an exact instant instead
      const scheduleIso = scheduleAt ? new Date(scheduleAt).toISOString() : null;
      if (scheduleIso && new Date(scheduleIso).getTime() <= Date.now()) {
        toast.error('Choose a time in the future, or clear it to send now');
        return;
      }
      await api.post(`/campaigns/${campaignCode}/send`, { schedule_at: scheduleIso });
      toast.success(scheduleAt ? 'Campaign scheduled!' : 'Campaign sending!');
      navigate(`/campaigns/${campaignCode}`);
    } catch (err: any) {
      toast.error(err.response?.data?.detail || 'Failed to send campaign');
    } finally { setLoading(false); }
  };

  // Footer content per step
  const renderFooter = () => {
    switch (step) {
      case 0:
        return (
          <WizardActionBar
            right={
              <button onClick={handleCreateCampaign} disabled={loading || !selectedIdentityId} className="btn-primary">
                {loading ? <Loader2 size={16} className="animate-spin" /> : null}
                {campaignCode ? 'Save & Continue' : 'Continue to Recipients'} <ArrowRight size={16} />
              </button>
            }
          />
        );
      case 1:
        return (
          <WizardActionBar
            left={<button type="button" onClick={() => goStep(0)} className="btn-secondary"><ArrowLeft size={16} /> Back</button>}
            center={
              hasRecipients ? (
                <span className="text-xs text-gray-500">
                  <strong className="text-gray-800">{includedCount.toLocaleString()}</strong> included
                  {' · '}
                  {recipientTotal.toLocaleString()} total
                </span>
              ) : null
            }
            right={
              hasRecipients && includedCount > 0 ? (
                <button type="button" onClick={() => goStep(3)} className="btn-primary">
                  Continue to Compose <ArrowRight size={16} />
                </button>
              ) : undefined
            }
          />
        );
      case 2:
        return (
          <WizardActionBar
            left={<button type="button" onClick={() => goStep(1)} className="btn-secondary"><ArrowLeft size={16} /> Back</button>}
            right={
              uploadResult ? (
                <button type="button" onClick={handleMappingComplete} disabled={!columnMapping.email_column || loading} className="btn-primary">
                  {loading ? <Loader2 size={16} className="animate-spin" /> : null}
                  Process & Continue <ArrowRight size={16} />
                </button>
              ) : hasRecipients ? (
                <button type="button" onClick={() => { setRecipientMode('review'); goStep(1); }} className="btn-primary">
                  Continue <ArrowRight size={16} />
                </button>
              ) : undefined
            }
          />
        );
      case 3:
        return (
          <WizardActionBar
            left={
              <button
                type="button"
                onClick={() => {
                  if (uploadResult && !hasRecipients) goStep(2);
                  else { setRecipientMode(hasRecipients ? 'review' : 'choose'); goStep(1); }
                }}
                className="btn-secondary"
              >
                <ArrowLeft size={16} /> Back
              </button>
            }
            right={
              <button
                type="button"
                onClick={async () => {
                  if (!htmlBody || !htmlBody.trim()) {
                    toast.error('Please compose an email or select a template first');
                    return;
                  }
                  await handleSaveContent(true);
                  goStep(4);
                }}
                disabled={!htmlBody || !htmlBody.trim() || savingContent}
                className="btn-primary"
              >
                Review & Send <ArrowRight size={16} />
              </button>
            }
          />
        );
      case 4:
        return (
          <WizardActionBar
            left={<button onClick={() => goStep(3)} className="btn-secondary"><ArrowLeft size={16} /> Back</button>}
            right={
              <button
                type="button"
                onClick={handleSend}
                disabled={loading}
                className={scheduleAt ? 'btn-primary' : 'btn-success'}
              >
                {loading ? <Loader2 size={16} className="animate-spin" /> :
                  scheduleAt ? <Clock size={16} /> : <Rocket size={16} />}
                {scheduleAt ? 'Schedule' : 'Send Now'}
              </button>
            }
          />
        );
      default:
        return null;
    }
  };

  // Step progress header
  const renderHeader = () => (
    <div className="bg-white border-b border-gray-100 px-4 sm:px-6 lg:px-8 py-4">
      <div className="max-w-[1680px] mx-auto">
        {/* Desktop progress */}
        <div className="hidden md:flex items-center justify-between">
          {STEPS.map((s, i) => {
            const isCompleted = i < step;
            const isCurrent = i === step;
            const canNavigate = i <= highestStepReached && (
              i === 0
              || (i === 1 && !!campaignCode)
              || (i === 2 && (!!uploadResult || hasRecipients))
              || (i === 3 && hasRecipients)
              || (i === 4 && !!htmlBody)
            );
            return (
              <div key={s} className="flex items-center">
                <motion.div
                  initial={false}
                  animate={{
                    backgroundColor: isCompleted ? '#4f46e5' : isCurrent ? '#eef2ff' : '#f3f4f6',
                    scale: isCurrent ? 1.1 : 1,
                  }}
                  transition={{ duration: 0.3 }}
                  onClick={() => canNavigate && goStep(i)}
                  className={`flex items-center justify-center w-9 h-9 rounded-xl text-sm font-semibold ${
                    isCompleted ? 'text-white shadow-md shadow-brand-500/20 cursor-pointer hover:scale-110' :
                    isCurrent ? 'text-brand-700 ring-2 ring-brand-500 ring-offset-2' :
                    'text-gray-400'
                  }`}
                  title={canNavigate ? `Go back to ${s}` : undefined}
                >
                  {isCompleted ? <Check size={16} /> : i + 1}
                </motion.div>
                <span
                  onClick={() => canNavigate && goStep(i)}
                  className={`ml-2 text-sm hidden lg:block ${
                    isCurrent ? 'font-semibold text-gray-900' :
                    isCompleted ? 'text-brand-600 font-medium cursor-pointer hover:underline' :
                    'text-gray-400'
                  }`}
                >{s}</span>
                {i < STEPS.length - 1 && (
                  <div className="w-8 lg:w-12 h-0.5 mx-2 lg:mx-3 rounded-full overflow-hidden bg-gray-200">
                    <motion.div
                      initial={false}
                      animate={{ width: i < step ? '100%' : '0%' }}
                      transition={{ duration: 0.4, ease: 'easeInOut' }}
                      className="h-full bg-gradient-to-r from-brand-500 to-brand-600 rounded-full"
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {/* Mobile compact indicator */}
        <div className="md:hidden flex items-center justify-between">
          <span className="text-sm font-semibold text-gray-900">
            Step {step + 1} of {STEPS.length}
          </span>
          <span className="text-sm text-gray-500">{STEPS[step]}</span>
        </div>
      </div>
    </div>
  );

  return (
    <WizardShell header={renderHeader()} footer={renderFooter()}>
      <AnimatePresence mode="wait" custom={direction}>
        <motion.div
          key={step}
          custom={direction}
          variants={slideVariants}
          initial="enter"
          animate="center"
          exit="exit"
          transition={{ duration: 0.3, ease: 'easeInOut' }}
        >
          {/* Step 0: Campaign Details */}
          {step === 0 && (
            <div className="space-y-6">
              <div>
                <h2 className="section-title">Campaign Details</h2>
                <p className="text-sm text-gray-500 mt-1">Set up the basics for your email campaign</p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <div className="sm:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Campaign Name *</label>
                  <input value={name} onChange={(e) => setName(e.target.value)}
                    className="input-field" placeholder="Q4 Newsletter" />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    Subject Line *
                    <span className={`float-right text-xs font-normal ${
                      subject.length > 60 ? 'text-amber-500' : 'text-gray-400'
                    }`}>{subject.length}/60</span>
                  </label>
                  <input value={subject} onChange={(e) => setSubject(e.target.value)}
                    className={`input-field ${subject.length > 60 ? 'border-amber-300 focus:ring-amber-500/20 focus:border-amber-500' : ''}`}
                    placeholder="Your subject line here — supports {{name}} merge fields" />
                  {subject.length > 60 && (
                    <p className="text-xs text-amber-500 mt-1.5 flex items-center gap-1">
                      <AlertCircle size={12} /> Subject lines over 60 characters may be truncated
                    </p>
                  )}
                </div>

                {/* Preheader */}
                <div className="sm:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    Preheader Text
                    <span className={`float-right text-xs font-normal ${
                      preheader.length > 100 ? 'text-amber-500' : 'text-gray-400'
                    }`}>{preheader.length}/100</span>
                  </label>
                  <input value={preheader} onChange={(e) => setPreheader(e.target.value)}
                    className="input-field"
                    placeholder="Preview text shown in inbox before opening the email" />
                  <p className="text-xs text-gray-500 mt-1">Shown as preview text in the inbox. Keep it under 100 characters.</p>
                </div>

                {/* Sender Identity */}
                <div className="sm:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Sender Identity *</label>
                  {loadingIdentities ? (
                    <div className="skeleton h-11 rounded-xl" />
                  ) : senderIdentities.length === 0 ? (
                    <div className="flex items-center gap-2.5 p-4 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-700">
                      <AlertCircle size={16} className="flex-shrink-0" />
                      No sender identities configured. Please add one in Settings first.
                    </div>
                  ) : (
                    <select
                      value={selectedIdentityId || ''}
                      onChange={(e) => setSelectedIdentityId(Number(e.target.value))}
                      className="input-field"
                    >
                      <option value="" disabled>Select a sender identity...</option>
                      {senderIdentities.map(id => (
                        <option key={id.id} value={id.id}>
                          {id.from_name} &lt;{id.from_email}&gt; · Reply: {id.reply_to || id.from_email}{id.is_default ? ' ★' : ''}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                {/* Custom From Name */}
                {selectedIdentity && (
                  <div className="sm:col-span-2">
                    <label className="flex items-center gap-2.5 cursor-pointer mb-2">
                      <input type="checkbox" checked={useCustomName} onChange={(e) => setUseCustomName(e.target.checked)}
                        className="w-4 h-4 text-brand-600 rounded border-gray-300 focus:ring-brand-500" />
                      <span className="text-sm text-gray-600">Use a custom "From Name" for this campaign</span>
                    </label>
                    {useCustomName && (
                      <input value={customFromName} onChange={(e) => setCustomFromName(e.target.value)}
                        className="input-field" placeholder={`Default: ${selectedIdentity.from_name}`} />
                    )}
                  </div>
                )}

                {/* Custom Reply-To */}
                {selectedIdentity && (
                  <div className="sm:col-span-2">
                    <label className="flex items-center gap-2.5 cursor-pointer mb-2">
                      <input type="checkbox" checked={useCustomReplyTo} onChange={(e) => setUseCustomReplyTo(e.target.checked)}
                        className="w-4 h-4 text-brand-600 rounded border-gray-300 focus:ring-brand-500" />
                      <span className="text-sm text-gray-600">Use a custom "Reply-To" email for this campaign</span>
                    </label>
                    {useCustomReplyTo ? (
                      <input type="email" value={customReplyTo} onChange={(e) => setCustomReplyTo(e.target.value)}
                        className="input-field" placeholder={`Default: ${selectedIdentity.reply_to || selectedIdentity.from_email}`} />
                    ) : (
                      <p className="text-xs text-gray-500 ml-6">
                        Replies will be sent to: <span className="font-semibold text-gray-700">{selectedIdentity.reply_to || selectedIdentity.from_email}</span>
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Step 1: Upload Recipients or Import / Review table */}
          {step === 1 && campaignCode && (
            <RecipientStep
              campaignCode={campaignCode}
              mode={recipientMode}
              onModeChange={setRecipientMode}
              onUploadComplete={handleUploadComplete}
              onImportComplete={async () => {
                await refreshRecipientCounts(campaignCode);
                setRecipientMode('review');
              }}
              onCountsChange={(inc, tot) => {
                setIncludedCount(inc);
                setRecipientTotal(tot);
                setHasRecipients(tot > 0);
              }}
            />
          )}

          {/* Step 2: Map Columns (or skip summary when already processed) */}
          {step === 2 && (
            <div className="space-y-6">
              {uploadResult ? (
                <>
                  <div>
                    <h2 className="section-title">Map Columns</h2>
                    <p className="text-sm text-gray-500 mt-1">
                      <span className="font-medium text-gray-600">{uploadResult.total_rows.toLocaleString()}</span> rows detected in{' '}
                      <span className="font-medium text-gray-600">{uploadResult.filename}</span>
                    </p>
                  </div>
                  <ColumnMapper columns={uploadResult.columns} mapping={columnMapping} onChange={(m) => {
                    setColumnMapping(m);
                    if (m.name_column && !mergeFields.some(f => f.name === 'name')) {
                      setMergeFields(prev => [...prev, { name: 'name', label: m.name_column!, defaultValue: '', source: 'csv' }]);
                    } else if (!m.name_column) {
                      setMergeFields(prev => prev.filter(f => !(f.name === 'name' && f.source === 'csv')));
                    }
                  }} />

                  <div className="border-t border-gray-100 pt-5">
                    <MergeFieldManager
                      fields={mergeFields} onChange={setMergeFields}
                      csvColumns={uploadResult.columns.filter(c => c !== columnMapping.email_column && c !== columnMapping.name_column)}
                    />
                  </div>

                  {uploadStatus && uploadStatus.status === 'processing' && (
                    <div className="flex items-center gap-3 p-4 bg-blue-50 rounded-xl">
                      <Loader2 size={16} className="animate-spin text-blue-600" />
                      <span className="text-sm text-blue-700 font-medium">
                        Processing: {uploadStatus.processed_rows} / {uploadStatus.total_rows}
                      </span>
                      <div className="flex-1 h-1.5 bg-blue-100 rounded-full overflow-hidden">
                        <div className="h-full bg-blue-500 rounded-full transition-all duration-300"
                          style={{ width: `${(uploadStatus.processed_rows / uploadStatus.total_rows) * 100}%` }} />
                      </div>
                    </div>
                  )}
                </>
              ) : hasRecipients ? (
                <div className="card-static p-6 space-y-3">
                  <h2 className="section-title">Recipients already mapped</h2>
                  <p className="text-sm text-gray-500">
                    This campaign already has <strong>{recipientTotal.toLocaleString()}</strong> recipients
                    ({includedCount.toLocaleString()} included). Continue to review them, or go back and upload a new file to replace the list.
                  </p>
                </div>
              ) : (
                <div className="card-static p-6">
                  <h2 className="section-title">No upload to map</h2>
                  <p className="text-sm text-gray-500 mt-1">Go back to Recipients and upload a CSV/Excel file first.</p>
                </div>
              )}
            </div>
          )}

          {/* Step 3: Compose — compose directly or select from template */}
          {step === 3 && campaignCode && (
            <div className="space-y-6">
              {/* Header with Tab Switcher */}
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-gray-200 pb-4">
                <div>
                  <h2 className="section-title">Compose your email</h2>
                  <p className="text-sm text-gray-500 mt-0.5">
                    Compose directly here in the editor, or pick from your saved templates.
                  </p>
                </div>
                <div className="inline-flex rounded-xl bg-gray-100 p-1 self-start sm:self-auto">
                  <button
                    type="button"
                    onClick={() => setComposeTab('compose')}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                      composeTab === 'compose'
                        ? 'bg-white text-gray-900 shadow-sm'
                        : 'text-gray-600 hover:text-gray-900'
                    }`}
                  >
                    <PenLine size={16} /> Compose here
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setComposeTab('template');
                      if (templates.length === 0) loadTemplates();
                    }}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                      composeTab === 'template'
                        ? 'bg-white text-gray-900 shadow-sm'
                        : 'text-gray-600 hover:text-gray-900'
                    }`}
                  >
                    <LayoutTemplate size={16} /> Select from template
                  </button>
                </div>
              </div>

              {composeTab === 'compose' ? (
                <div className="space-y-4">
                  {/* Status & Quick Actions Bar */}
                  <div className="flex items-center justify-between flex-wrap gap-2 bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                        htmlBody && htmlBody.trim() ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
                      }`}>
                        {htmlBody && htmlBody.trim() ? <Check size={12} /> : <AlertCircle size={12} />}
                        {htmlBody && htmlBody.trim() ? 'Content Ready' : 'Empty Email Content'}
                      </span>
                      {selectedTemplateId && (
                        <span className="text-xs text-gray-500 hidden sm:inline">
                          Template loaded
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setComposeTab('template');
                          if (templates.length === 0) loadTemplates();
                        }}
                        className="btn-secondary text-xs py-1.5"
                      >
                        <LayoutTemplate size={14} /> Choose Template
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSaveContent(false)}
                        disabled={savingContent}
                        className="btn-secondary text-xs py-1.5"
                      >
                        {savingContent ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                        Save Draft
                      </button>
                      <button
                        type="button"
                        onClick={() => navigate(`/composer/campaign/${campaignCode}`)}
                        className="text-xs text-gray-500 hover:text-brand-600 flex items-center gap-1 px-2 py-1 transition-colors"
                        title="Open advanced visual block builder"
                      >
                        <PanelsTopLeft size={13} /> Visual Builder ↗
                      </button>
                    </div>
                  </div>

                  {/* Inline Editor Workspace */}
                  <div className="flex flex-col min-h-[560px] h-[72vh] max-h-[920px] rounded-xl border border-gray-200 overflow-hidden shadow-sm bg-white">
                    <div className="flex-1 min-h-0">
                      <EditorSelector
                        editorType={editorType}
                        onEditorTypeChange={setEditorType}
                        htmlBody={htmlBody}
                        onHtmlChange={(html) => {
                          setHtmlBody(html);
                          if (html && !contentStatus) setContentStatus('published');
                        }}
                        contentJson={contentJson}
                        onContentJsonChange={setContentJson}
                        mergeFields={mergeFields.map(f => ({ name: f.name, label: f.label }))}
                        themeConfig={themeConfig}
                        editorContext="campaign"
                        subject={subject}
                        onSubjectChange={setSubject}
                        preheader={preheader}
                        onPreheaderChange={setPreheader}
                        senderIdentity={selectedIdentity}
                        totalRecipients={includedCount}
                        campaignMergeFields={campaignMergeFields}
                        onThemeChange={setThemeConfig}
                        onSave={() => handleSaveContent(false)}
                        sidePanel={
                          <div className="flex flex-col h-full min-h-0">
                            <div className="px-3 py-2 border-b border-gray-100 text-xs font-semibold text-gray-600 flex items-center justify-between">
                              <span>Live Preview</span>
                              <span className="text-[11px] text-gray-400 truncate max-w-[140px]">
                                {subject ? `Subject: ${subject}` : 'No subject'}
                              </span>
                            </div>
                            <div className="flex-1 min-h-0 overflow-y-auto p-3">
                              <PreviewPane html={htmlBody} themeConfig={themeConfig} />
                            </div>
                          </div>
                        }
                      />
                    </div>
                  </div>
                </div>
              ) : (
                /* Select from Template Gallery */
                <div className="space-y-4">
                  <div className="flex items-center justify-between flex-wrap gap-3">
                    <div className="relative flex-1 max-w-md">
                      <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                      <input
                        type="text"
                        value={templateSearch}
                        onChange={e => setTemplateSearch(e.target.value)}
                        placeholder="Search templates..."
                        className="input-field pl-9 py-2 text-sm"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setComposeTab('compose')}
                        className="btn-secondary text-xs"
                      >
                        <ArrowLeft size={14} /> Back to Editor
                      </button>
                      <button
                        type="button"
                        onClick={() => navigate('/templates')}
                        className="btn-secondary text-xs"
                      >
                        <Plus size={14} /> Manage Templates
                      </button>
                    </div>
                  </div>

                  {loadingTemplates ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                      {[1, 2, 3].map(i => (
                        <div key={i} className="card-static p-4 space-y-3">
                          <div className="skeleton h-36 rounded-lg" />
                          <div className="skeleton h-4 w-32" />
                          <div className="skeleton h-3 w-48" />
                        </div>
                      ))}
                    </div>
                  ) : filteredTemplates.length === 0 ? (
                    <div className="card-static p-8 text-center flex flex-col items-center gap-3">
                      <FileText size={32} className="text-gray-300" />
                      <h3 className="font-semibold text-gray-800">
                        {templates.length === 0 ? 'No templates created yet' : 'No templates match your search'}
                      </h3>
                      <p className="text-xs text-gray-500 max-w-sm">
                        {templates.length === 0
                          ? 'You can compose your email directly here in the editor, or create reusable templates on the Templates page.'
                          : 'Try searching with a different keyword.'}
                      </p>
                      <div className="flex items-center gap-2 mt-2">
                        <button
                          type="button"
                          onClick={() => setComposeTab('compose')}
                          className="btn-primary"
                        >
                          <PenLine size={16} /> Compose here
                        </button>
                        <button
                          type="button"
                          onClick={() => navigate('/templates')}
                          className="btn-secondary"
                        >
                          <Plus size={16} /> Create Template
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                      {filteredTemplates.map(t => {
                        const isCurrent = (selectedTemplateId === t.id) || (htmlBody && t.html_output === htmlBody);
                        return (
                          <div
                            key={t.public_code}
                            className={`card group p-4 flex flex-col justify-between transition-all ${
                              isCurrent ? 'ring-2 ring-brand-500 bg-brand-50/10' : ''
                            }`}
                          >
                            <div>
                              <div className="flex items-start justify-between gap-2 mb-2">
                                <h4 className="font-semibold text-gray-900 group-hover:text-brand-600 transition-colors truncate">
                                  {t.name}
                                </h4>
                                <span className="badge-gray capitalize text-[10px] shrink-0">{t.editor_type}</span>
                              </div>
                              <p className="text-xs text-gray-500 line-clamp-2 mb-3 min-h-[32px]">
                                {t.description || 'No description provided'}
                              </p>
                              <div className="border border-gray-100 rounded-lg overflow-hidden h-40 bg-gray-50 mb-3">
                                {t.html_output ? (
                                  <iframe
                                    srcDoc={t.html_output}
                                    className="w-full h-full border-0 pointer-events-none transform scale-90 origin-top"
                                    title={`${t.name} preview`}
                                    sandbox=""
                                  />
                                ) : (
                                  <div className="h-full flex items-center justify-center text-gray-300">
                                    <FileText size={24} />
                                  </div>
                                )}
                              </div>
                            </div>
                            <div className="pt-2 border-t border-gray-100 flex items-center justify-between">
                              <span className="text-[11px] text-gray-400 font-mono">{t.public_code}</span>
                              <button
                                type="button"
                                onClick={() => handleSelectTemplate(t)}
                                className={isCurrent ? 'btn-success text-xs py-1.5' : 'btn-primary text-xs py-1.5'}
                              >
                                {isCurrent ? (
                                  <>
                                    <Check size={14} /> Selected
                                  </>
                                ) : (
                                  'Use This Template'
                                )}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Step 4: Review & Send */}
          {step === 4 && (
            <div className="space-y-6">
              <div>
                <h2 className="section-title">Review & Send</h2>
                <p className="text-sm text-gray-500 mt-1">Double-check everything before sending</p>
              </div>

              {/* Summary Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="bg-gray-50 rounded-xl p-4 space-y-2.5">
                  <div className="flex justify-between">
                    <span className="text-xs text-gray-500 font-medium uppercase tracking-wide">Campaign</span>
                    <span className="text-sm font-semibold text-gray-900">{name}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-xs text-gray-500 font-medium uppercase tracking-wide">Subject</span>
                    <span className="text-sm font-semibold text-gray-900 max-w-[200px] truncate">{subject}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-xs text-gray-500 font-medium uppercase tracking-wide">Content</span>
                    <span className={htmlBody && htmlBody.trim() ? 'badge-success' : 'badge-warning'}>
                      {htmlBody && htmlBody.trim() ? 'Ready to Send' : 'Empty'}
                    </span>
                  </div>
                </div>
                <div className="bg-gray-50 rounded-xl p-4 space-y-2.5">
                  <div className="flex justify-between">
                    <span className="text-xs text-gray-500 font-medium uppercase tracking-wide">From</span>
                    <span className="text-sm font-semibold text-gray-900 max-w-[200px] truncate">
                      {selectedIdentity ? `${useCustomName ? customFromName : selectedIdentity.from_name}` : '—'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-xs text-gray-500 font-medium uppercase tracking-wide">Recipients</span>
                    <span className="text-sm font-bold text-brand-600">{(includedCount || uploadStatus?.valid_rows)?.toLocaleString() || '—'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-xs text-gray-500 font-medium uppercase tracking-wide">Skipped</span>
                    <span className="text-sm text-gray-500">{(uploadStatus?.invalid_rows || 0) + (uploadStatus?.duplicate_rows || 0)}</span>
                  </div>
                </div>
              </div>

              {/* Preview */}
              <div className="card-static overflow-hidden">
                <div className="px-4 py-3 bg-gray-50 border-b border-gray-100">
                  <h3 className="text-sm font-semibold text-gray-700">Email Preview</h3>
                </div>
                <div className="p-4">
                  <PreviewPane html={htmlBody} themeConfig={themeConfig} />
                </div>
              </div>

              {/* Schedule */}
              <div className="bg-gray-50 rounded-xl p-5">
                <label className="flex items-center gap-2 text-sm font-medium text-gray-700 mb-3">
                  <CalendarClock size={16} className="text-gray-400" />
                  Schedule (optional)
                </label>
                <input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)}
                  className="input-field max-w-xs" />
                <p className="text-xs text-gray-500 mt-2">Leave empty to send immediately</p>
              </div>
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </WizardShell>
  );
}


// ─── Recipient Step Component ───

function RecipientStep({
  campaignCode,
  mode,
  onModeChange,
  onUploadComplete,
  onImportComplete,
  onCountsChange,
}: {
  campaignCode: string;
  mode: 'choose' | 'upload' | 'import' | 'review';
  onModeChange: (m: 'choose' | 'upload' | 'import' | 'review') => void;
  onUploadComplete: (data: UploadResponse) => void;
  onImportComplete: () => void;
  onCountsChange?: (included: number, total: number) => void;
}) {
  const [campaigns, setCampaigns] = useState<CampaignListItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ copied: number; duplicates: number; suppressed: number; total_recipients: number } | null>(null);

  const loadCampaigns = async () => {
    try {
      const res = await api.get('/campaigns/');
      setCampaigns((res.data as CampaignListItem[]).filter(c => c.public_code !== campaignCode && c.total_recipients > 0));
    } catch { /* ignore */ }
  };

  const handleImport = async (source: CampaignListItem) => {
    setImporting(true);
    try {
      const res = await api.post(`/campaigns/${campaignCode}/import-recipients`, {
        source_campaign_code: source.public_code,
      });
      setImportResult(res.data);
      toast.success(`Imported ${res.data.copied} recipients`);
      onImportComplete();
    } catch (err: any) {
      toast.error(err.response?.data?.detail || 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  const filteredCampaigns = campaigns.filter(c =>
    c.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (mode === 'review') {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="section-title">Recipients</h2>
            <p className="text-sm text-gray-500 mt-1">
              Review the list, check/uncheck who should receive this campaign, then continue.
            </p>
          </div>
          <button type="button" onClick={() => onModeChange('choose')} className="btn-secondary btn-sm">
            Replace list
          </button>
        </div>
        <RecipientTable campaignCode={campaignCode} onCountsChange={onCountsChange} />
      </div>
    );
  }

  // Choose mode
  if (mode === 'choose') {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="section-title">Add Recipients</h2>
          <p className="text-sm text-gray-500 mt-1">Choose how to add recipients to this campaign</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <motion.button
            type="button"
            whileHover={{ scale: 1.02, y: -2 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => onModeChange('upload')}
            className="p-6 rounded-2xl border-2 border-gray-100 hover:border-brand-200 text-left transition-all group"
          >
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center mb-4 shadow-lg group-hover:shadow-brand-500/30 transition-shadow">
              <Upload size={20} className="text-white" />
            </div>
            <h3 className="font-semibold text-gray-900 mb-1">Upload File</h3>
            <p className="text-xs text-gray-500">Upload a CSV or Excel file with recipient data</p>
          </motion.button>
          <motion.button
            type="button"
            whileHover={{ scale: 1.02, y: -2 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => { onModeChange('import'); loadCampaigns(); }}
            className="p-6 rounded-2xl border-2 border-gray-100 hover:border-accent-200 text-left transition-all group"
          >
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-accent-400 to-accent-600 flex items-center justify-center mb-4 shadow-lg group-hover:shadow-accent-500/30 transition-shadow">
              <Users size={20} className="text-white" />
            </div>
            <h3 className="font-semibold text-gray-900 mb-1">Import from Campaign</h3>
            <p className="text-xs text-gray-500">Copy recipients from an existing campaign</p>
          </motion.button>
        </div>
      </div>
    );
  }

  // Upload mode
  if (mode === 'upload') {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="section-title">Upload Recipients</h2>
          <p className="text-sm text-gray-500 mt-1">Upload a CSV or Excel file with your recipients</p>
        </div>
        <FileUpload campaignCode={campaignCode} onUploadComplete={onUploadComplete} />
        <div className="flex justify-between pt-2">
          <button type="button" onClick={() => onModeChange('choose')} className="btn-secondary">
            <ArrowLeft size={16} /> Back
          </button>
        </div>
      </div>
    );
  }

  // Import mode
  return (
    <div className="space-y-6">
      <div>
        <h2 className="section-title">Import from Campaign</h2>
        <p className="text-sm text-gray-500 mt-1">Select a campaign to copy recipients from</p>
      </div>

      {importResult ? (
        <div className="card-static p-6 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center">
              <Check size={20} className="text-emerald-600" />
            </div>
            <div>
              <h3 className="font-semibold text-gray-900">Import Complete</h3>
              <p className="text-sm text-gray-500">Recipients have been added to this campaign</p>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="p-3 bg-emerald-50 rounded-xl text-center">
              <p className="text-lg font-bold text-emerald-700">{importResult.copied}</p>
              <p className="text-xs text-emerald-600">Imported</p>
            </div>
            <div className="p-3 bg-amber-50 rounded-xl text-center">
              <p className="text-lg font-bold text-amber-700">{importResult.duplicates}</p>
              <p className="text-xs text-amber-600">Duplicates</p>
            </div>
            <div className="p-3 bg-red-50 rounded-xl text-center">
              <p className="text-lg font-bold text-red-700">{importResult.suppressed}</p>
              <p className="text-xs text-red-600">Suppressed</p>
            </div>
          </div>
          <p className="text-sm text-gray-500">Total recipients: <strong>{importResult.total_recipients}</strong></p>
        </div>
      ) : (
        <>
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="search"
              placeholder="Search campaigns..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="input-field pl-10"
              aria-label="Search campaigns to import recipients from"
            />
          </div>
          <div className="space-y-2 max-h-80 overflow-y-auto">
            {filteredCampaigns.length === 0 ? (
              <div className="text-center py-8 text-sm text-gray-500">No campaigns with recipients found</div>
            ) : (
              filteredCampaigns.map(c => (
                <button
                  key={c.public_code}
                  type="button"
                  onClick={() => handleImport(c)}
                  disabled={importing}
                  className="w-full card-static p-4 flex items-center justify-between hover:border-brand-200 transition-all text-left cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-gray-900">{c.name}</span>
                      <span className="font-mono text-[11px] text-gray-500">{c.public_code}</span>
                    </div>
                    <p className="text-xs text-gray-500">{c.total_recipients} recipients · {c.status}</p>
                  </div>
                  {importing ? (
                    <Loader2 size={16} className="animate-spin text-brand-500" />
                  ) : (
                    <ArrowRight size={16} className="text-gray-400" />
                  )}
                </button>
              ))
            )}
          </div>
        </>
      )}

      <div className="flex justify-between pt-2">
        <button type="button" onClick={() => { onModeChange('choose'); setImportResult(null); }} className="btn-secondary">
          <ArrowLeft size={16} /> Back
        </button>
        {importResult && importResult.copied > 0 && (
          <button type="button" onClick={() => onModeChange('review')} className="btn-primary">
            Review Recipients <ArrowRight size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
