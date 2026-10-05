import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import api from '../services/api';
import { getCampaignFieldDefinitions, renderCampaignPreview } from '../services/api';
import toast from 'react-hot-toast';
import FileUpload from '../components/FileUpload';
import ColumnMapper from '../components/ColumnMapper';
import EditorSelector from '../components/EditorSelector';
import MergeFieldManager from '../components/MergeFieldManager';
import type { MergeFieldDef } from '../components/MergeFieldManager';
import PreviewPane from '../editors/PreviewPane';
import WizardShell from '../components/WizardShell';
import WizardActionBar from '../components/WizardActionBar';
import AutosaveStatus from '../components/AutosaveStatus';
import RecipientPreviewNavigator from '../components/RecipientPreviewNavigator';
import RecipientTable from '../components/RecipientTable';
import TemplateFieldBindingPanel from '../components/TemplateFieldBindingPanel';
import Modal from '../components/ui/Modal';
import type {
  EditorType, ColumnMapping, ThemeConfig, UploadResponse, UploadStatus,
  SenderIdentity, Template, MergeFieldDefinition, TemplateFieldBinding, PreviewRecipient,
  CampaignListItem,
} from '../types';
import {
  ArrowLeft, ArrowRight, Clock, Check, PenLine, FileText,
  AlertCircle, Loader2, Rocket, CalendarClock, Upload, Users, Search, Save, PanelsTopLeft
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

  // Step 4: Compose
  const [composeMode, setComposeMode] = useState<'scratch' | 'template' | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [editorType, setEditorType] = useState<EditorType>('custom');
  const [htmlBody, setHtmlBody] = useState('');
  const [contentJson, setContentJson] = useState('');
  const [themeConfig, setThemeConfig] = useState<ThemeConfig | null>(null);


  // Step 5: Schedule
  const [scheduleAt, setScheduleAt] = useState('');

  // Canonical field system
  const [campaignFieldDefs, setCampaignFieldDefs] = useState<MergeFieldDefinition[]>([]);
  const [templateFieldBindings, setTemplateFieldBindings] = useState<TemplateFieldBinding[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<number | null>(null);

  // Template binding modal
  const [showBindingModal, setShowBindingModal] = useState(false);
  const [pendingTemplate, setPendingTemplate] = useState<Template | null>(null);
  const [bindingTemplateFields, setBindingTemplateFields] = useState<MergeFieldDefinition[]>([]);
  const [bindingSampleValues, setBindingSampleValues] = useState<Record<string, string>>({});

  // Live preview
  const [previewRecipient, setPreviewRecipient] = useState<PreviewRecipient | null>(null);
  const [previewHtml, setPreviewHtml] = useState('');

  // Autosave
  const [autosaveStatus, setAutosaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveVersionRef = useRef(0);

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
        if (c.editor_type) setEditorType(c.editor_type as EditorType);
        if (c.html_body) setHtmlBody(c.html_body);
        if (c.content_json) setContentJson(c.content_json);
        if (c.theme_config) setThemeConfig(c.theme_config);
        if (c.merge_fields_config) setMergeFields(c.merge_fields_config);

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
        let landing = 1;
        if (!recipientsOk) landing = 1;
        else if (!hasContent) landing = 3;
        else landing = 3;
        setComposeMode(hasContent ? 'scratch' : null);
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
        // Create new campaign
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
    const cols = result.columns || [];
    const emailCol = cols.find(c => {
      const l = c.trim().toLowerCase();
      return l === 'email' || l === 'e-mail' || l === 'email address' || l === 'email_address';
    }) || cols.find(c => c.trim().toLowerCase().includes('email')) || '';

    const nameCol = cols.find(c => {
      const l = c.trim().toLowerCase();
      return l === 'name' || l === 'full name' || l === 'fullname' || l === 'first name' || l === 'firstname' || l === 'contact name';
    }) || cols.find(c => c.trim().toLowerCase().includes('name'));

    setColumnMapping({
      email_column: emailCol,
      name_column: nameCol || undefined,
    });

    if (nameCol && !mergeFields.some(f => f.name === 'name')) {
      setMergeFields(prev => [...prev, { name: 'name', label: nameCol, defaultValue: '', source: 'csv' }]);
    }

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

  const handleSaveContent = async () => {
    if (!campaignCode) return;
    setLoading(true);
    try {
      await api.patch(`/campaigns/${campaignCode}`, {
        editor_type: editorType,
        content_json: contentJson,
        html_body: htmlBody,
        theme_config: themeConfig,
        merge_fields_config: mergeFields,
      });
      goStep(4);
    } catch (err: any) {
      toast.error(err.response?.data?.detail || 'Failed to save content');
    } finally { setLoading(false); }
  };

  const handleLoadTemplates = async () => {
    setLoadingTemplates(true);
    try { const res = await api.get('/templates/'); setTemplates(res.data); }
    catch { toast.error('Failed to load templates'); }
    finally { setLoadingTemplates(false); }
  };

  const handleSelectTemplate = (template: Template) => {
    // If template has canonical field definitions, show binding modal
    const templateDefs = template.merge_field_definitions_json || [];
    if (templateDefs.length > 0 && campaignFieldDefs.length > 0) {
      setPendingTemplate(template);
      setBindingTemplateFields(templateDefs);
      // Auto-map first
      const autoBindings = templateDefs.map(tf => {
        const match = campaignFieldDefs.find(cf => cf.key === tf.key || cf.key === tf.key.toLowerCase());
        return { template_field_key: tf.key, campaign_field_key: match?.key || null };
      });
      setTemplateFieldBindings(autoBindings);
      setShowBindingModal(true);
      return;
    }
    
    // No template fields to bind — just apply directly
    applyTemplate(template, []);
  };

  const applyTemplate = async (template: Template, bindings: TemplateFieldBinding[]) => {
    setEditorType(template.editor_type as EditorType);
    setHtmlBody(template.html_output || '');
    setContentJson(template.content_json || '');
    if (template.theme_config) { try { setThemeConfig(JSON.parse(template.theme_config)); } catch { /* */ } }
    if (template.merge_fields_config) {
      try {
        const tmplFields: MergeFieldDef[] = JSON.parse(template.merge_fields_config);
        const existingNames = new Set(mergeFields.map(f => f.name));
        setMergeFields([...mergeFields, ...tmplFields.filter(f => !existingNames.has(f.name))]);
      } catch { /* */ }
    }
    setSelectedTemplateId(template.id ?? null);
    setTemplateFieldBindings(bindings);
    setComposeMode('scratch');
    setShowBindingModal(false);
    setPendingTemplate(null);
    
    // Persist template selection and bindings
    if (campaignCode) {
      try {
        await api.patch(`/campaigns/${campaignCode}`, {
          selected_template_id: template.id,
          template_field_bindings_json: bindings,
        });
      } catch { /* non-blocking */ }
    }
    toast.success(`Template "${template.name}" applied`);
  };

  const handleBindingApply = (bindings: TemplateFieldBinding[]) => {
    if (pendingTemplate) {
      applyTemplate(pendingTemplate, bindings);
    }
  };

  // Load campaign field definitions when entering compose
  const loadFieldDefinitions = useCallback(async () => {
    if (!campaignCode) return;
    try {
      const data = await getCampaignFieldDefinitions(campaignCode);
      if (data.field_definitions) setCampaignFieldDefs(data.field_definitions);
      if (data.template_field_bindings) setTemplateFieldBindings(data.template_field_bindings);
      if (data.selected_template_id) setSelectedTemplateId(data.selected_template_id);
      if (data.sample_values) setBindingSampleValues(data.sample_values);
    } catch { /* non-critical */ }
  }, [campaignCode]);

  useEffect(() => {
    if (step === 3 && campaignCode) loadFieldDefinitions();
  }, [step, campaignCode, loadFieldDefinitions]);

  // Debounced autosave
  const triggerAutosave = useCallback(() => {
    if (!campaignCode || !htmlBody) return;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    
    const version = ++saveVersionRef.current;
    autosaveTimerRef.current = setTimeout(async () => {
      if (saveVersionRef.current !== version) return; // stale
      setAutosaveStatus('saving');
      try {
        await api.patch(`/campaigns/${campaignCode}`, {
          editor_type: editorType,
          content_json: contentJson,
          html_body: htmlBody,
          theme_config: themeConfig,
          merge_fields_config: mergeFields,
          campaign_field_definitions_json: campaignFieldDefs.length > 0 ? campaignFieldDefs : undefined,
          template_field_bindings_json: templateFieldBindings.length > 0 ? templateFieldBindings : undefined,
          selected_template_id: selectedTemplateId,
        });
        if (saveVersionRef.current === version) {
          setAutosaveStatus('saved');
          setLastSavedAt(new Date());
        }
      } catch {
        if (saveVersionRef.current === version) setAutosaveStatus('error');
      }
    }, 1500);
  }, [campaignCode, editorType, contentJson, htmlBody, themeConfig, mergeFields, campaignFieldDefs, templateFieldBindings, selectedTemplateId]);

  // Trigger autosave when compose content changes
  useEffect(() => {
    if (step === 3 && htmlBody) triggerAutosave();
  }, [htmlBody, contentJson, themeConfig]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced preview rendering
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const renderPreview = useCallback((recipient?: PreviewRecipient) => {
    if (!campaignCode) return;
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    previewTimerRef.current = setTimeout(async () => {
      try {
        const data = await renderCampaignPreview(campaignCode, {
          recipient_index: recipient?.index ?? previewRecipient?.index ?? 0,
          subject, preheader, html: htmlBody,
        });
        setPreviewHtml(data.html);
      } catch { /* non-critical */ }
    }, 350);
  }, [campaignCode, subject, preheader, htmlBody, previewRecipient]);

  useEffect(() => {
    if (step === 3 && campaignCode && htmlBody && (composeMode === 'scratch' || htmlBody)) {
      renderPreview();
    }
  }, [htmlBody, subject, preheader]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRecipientChange = useCallback((recipient: PreviewRecipient) => {
    setPreviewRecipient(recipient);
    renderPreview(recipient);
  }, [renderPreview]);

  // Insert merge field into editor
  const handleInsertMergeField = (key: string) => {
    // Dispatch custom event that editors listen to
    window.dispatchEvent(new CustomEvent('insert-merge-field', { detail: { key } }));
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
    const autosaveCenter = step === 3 ? (
      <AutosaveStatus status={autosaveStatus} lastSavedAt={lastSavedAt} onRetry={triggerAutosave} />
    ) : null;

    switch (step) {
      case 0:
        return (
          <WizardActionBar
            center={autosaveCenter}
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
              ) : autosaveCenter
            }
            right={
              hasRecipients && includedCount > 0 ? (
                <button type="button" onClick={() => { setComposeMode(htmlBody ? 'scratch' : null); goStep(3); }} className="btn-primary">
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
            center={autosaveCenter}
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
            center={autosaveCenter}
            right={
              (composeMode === 'scratch' || htmlBody) ? (
                <div className="flex items-center gap-2">
                  <button onClick={() => triggerAutosave()} className="btn-secondary hidden sm:flex">
                    <Save size={14} /> Save Draft
                  </button>
                  <button onClick={handleSaveContent} disabled={!htmlBody || loading} className="btn-primary">
                    {loading ? <Loader2 size={16} className="animate-spin" /> : null}
                    Review & Send <ArrowRight size={16} />
                  </button>
                </div>
              ) : undefined
            }
          />
        );
      case 4:
        return (
          <WizardActionBar
            left={<button onClick={() => goStep(3)} className="btn-secondary"><ArrowLeft size={16} /> Back</button>}
            center={autosaveCenter}
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
                          {id.from_name} &lt;{id.from_email}&gt;{id.reply_to ? ` (reply-to: ${id.reply_to})` : ''}{id.is_default ? ' ★' : ''}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                {/* Reply-To Email */}
                <div className="sm:col-span-2">
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-sm font-medium text-gray-700">Reply-To Email</label>
                    <label className="flex items-center gap-1.5 text-xs text-brand-600 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={useCustomReplyTo}
                        onChange={(e) => setUseCustomReplyTo(e.target.checked)}
                        className="rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                      />
                      Custom Reply-To
                    </label>
                  </div>
                  {useCustomReplyTo ? (
                    <input
                      type="email"
                      value={customReplyTo}
                      onChange={(e) => setCustomReplyTo(e.target.value)}
                      placeholder={selectedIdentity?.reply_to || selectedIdentity?.from_email || 'reply@yourdomain.com'}
                      className="input-field"
                    />
                  ) : (
                    <div className="input-field bg-gray-50 text-gray-500 flex items-center justify-between">
                      <span className="truncate">
                        {selectedIdentity ? (selectedIdentity.reply_to || selectedIdentity.from_email) : 'Select a sender identity'}
                      </span>
                      <span className="text-[11px] text-gray-400 font-medium">Auto-defaults to Sender</span>
                    </div>
                  )}
                  <p className="text-xs text-gray-400 mt-1">
                    Where recipients' direct replies will be delivered.
                  </p>
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

          {/* Step 3: Compose */}
          {step === 3 && (
            <div className="space-y-6">
              {campaignCode && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-brand-100 bg-brand-50/60 px-3 py-2">
                  <p className="text-xs text-brand-900">
                    Prefer the new composer? It adds a block editor, HTML editor with validation, revisions and test sends.
                  </p>
                  <button
                    type="button"
                    onClick={() => navigate(`/composer/campaign/${campaignCode}`)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-brand-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-brand-700 transition-colors hover:bg-brand-50"
                  >
                    <PanelsTopLeft size={14} />
                    Open in new composer
                  </button>
                </div>
              )}
              {/* Compose Mode Selection — only show if no content yet */}
              {composeMode === null && !htmlBody && (
                <>
                  <div>
                    <h2 className="section-title">How would you like to compose?</h2>
                    <p className="text-sm text-gray-500 mt-1">Choose your starting point</p>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                    <motion.button
                      whileHover={{ scale: 1.02, y: -2 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => setComposeMode('scratch')}
                      className="flex flex-col items-center gap-4 p-8 border-2 border-gray-200 rounded-2xl hover:border-brand-400 hover:shadow-glow transition-all group text-left"
                    >
                      <div className="w-16 h-16 bg-gradient-to-br from-brand-100 to-accent-100 rounded-2xl flex items-center justify-center group-hover:shadow-lg transition-shadow">
                        <PenLine size={28} className="text-brand-600" />
                      </div>
                      <div className="text-center">
                        <span className="font-display font-semibold text-gray-900">Start from Scratch</span>
                        <p className="text-xs text-gray-500 mt-1.5">Open the editor and compose from a blank canvas</p>
                      </div>
                    </motion.button>
                    <motion.button
                      whileHover={{ scale: 1.02, y: -2 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => { setComposeMode('template'); handleLoadTemplates(); }}
                      className="flex flex-col items-center gap-4 p-8 border-2 border-gray-200 rounded-2xl hover:border-accent-400 hover:shadow-glow transition-all group text-left"
                    >
                      <div className="w-16 h-16 bg-gradient-to-br from-accent-100 to-pink-100 rounded-2xl flex items-center justify-center group-hover:shadow-lg transition-shadow">
                        <FileText size={28} className="text-accent-600" />
                      </div>
                      <div className="text-center">
                        <span className="font-display font-semibold text-gray-900">Choose a Template</span>
                        <p className="text-xs text-gray-500 mt-1.5">Start with a pre-built template and customize it</p>
                      </div>
                    </motion.button>
                  </div>
                </>
              )}

              {/* Template Selection */}
              {composeMode === 'template' && !htmlBody && (
                <>
                  <div className="flex items-center justify-between">
                    <div>
                      <h2 className="section-title">Choose a Template</h2>
                      <p className="text-sm text-gray-500 mt-1">{templates.length} template{templates.length !== 1 ? 's' : ''} available</p>
                    </div>
                    <button onClick={() => setComposeMode(null)} className="btn-ghost text-sm">
                      ← Back to options
                    </button>
                  </div>
                  {loadingTemplates ? (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      {[1, 2, 3].map(i => (
                        <div key={i} className="card-static p-4 space-y-3">
                          <div className="skeleton h-24 rounded-xl" />
                          <div className="skeleton h-4 w-32" />
                          <div className="skeleton h-3 w-20" />
                        </div>
                      ))}
                    </div>
                  ) : templates.length === 0 ? (
                    <div className="text-center py-16">
                      <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gray-100 flex items-center justify-center">
                        <FileText size={28} className="text-gray-300" />
                      </div>
                      <p className="text-gray-500 font-medium">No templates yet</p>
                      <button onClick={() => setComposeMode('scratch')} className="text-sm text-brand-600 hover:underline mt-2">
                        Start from scratch instead
                      </button>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      {templates.map(tmpl => (
                        <motion.button
                          key={tmpl.id}
                          whileHover={{ y: -3 }}
                          onClick={() => handleSelectTemplate(tmpl)}
                          className="card text-left p-4 group"
                        >
                          <div className="h-24 bg-gray-50 rounded-xl mb-3 flex items-center justify-center group-hover:bg-accent-50 transition-colors">
                            <FileText size={24} className="text-gray-300 group-hover:text-accent-400 transition-colors" />
                          </div>
                          <p className="text-sm font-semibold text-gray-800 truncate">{tmpl.name}</p>
                          <p className="text-xs text-gray-500 mt-0.5 truncate">{tmpl.description || 'No description'}</p>
                          <span className="badge-gray mt-2 text-[10px] capitalize">{tmpl.editor_type}</span>
                        </motion.button>
                      ))}
                    </div>
                  )}
                </>
              )}

              {/* Editor — show when composing */}
              {(composeMode === 'scratch' || (composeMode === 'template' && htmlBody) || (composeMode === null && htmlBody)) && (
                <>
                  <div className="flex-1 min-h-[500px] h-[70vh] max-h-[calc(100vh-220px)] flex flex-col">
                    <EditorSelector editorType={editorType} onEditorTypeChange={setEditorType}
                      htmlBody={htmlBody} onHtmlChange={setHtmlBody}
                      contentJson={contentJson} onContentJsonChange={setContentJson}
                      mergeFields={mergeFields.map(f => ({ name: f.name, label: f.label }))}
                      themeConfig={themeConfig}
                      // Compose workspace props
                      editorContext="campaign"
                      subject={subject}
                      onSubjectChange={setSubject}
                      preheader={preheader}
                      onPreheaderChange={setPreheader}
                      senderIdentity={selectedIdentity}
                      onChangeSender={() => goStep(0)}
                      totalRecipients={includedCount || uploadStatus?.valid_rows || 0}
                      onViewRecipients={() => goStep(1)}
                      campaignMergeFields={campaignFieldDefs}
                      onInsertMergeField={handleInsertMergeField}
                      onThemeChange={setThemeConfig}
                      onSave={triggerAutosave}
                      onReviewSend={handleSaveContent}
                      sidePanel={
                        <div className="flex flex-col h-full">
                          {campaignCode && (
                            <RecipientPreviewNavigator
                              campaignCode={campaignCode}
                              onRecipientChange={handleRecipientChange}
                            />
                          )}
                          <div className="flex-1 min-h-0 overflow-y-auto p-3">
                            <PreviewPane html={previewHtml || htmlBody} themeConfig={themeConfig} />
                          </div>
                        </div>
                      }
                    />
                  </div>
                </>
              )}

              {/* Template Binding Modal */}
              <Modal open={showBindingModal} onClose={() => setShowBindingModal(false)} title="Map Template Fields" width="xl">
                <TemplateFieldBindingPanel
                  templateFields={bindingTemplateFields}
                  campaignFields={campaignFieldDefs}
                  initialBindings={templateFieldBindings}
                  sampleValues={bindingSampleValues}
                  onApply={handleBindingApply}
                  onCancel={() => setShowBindingModal(false)}
                />
              </Modal>
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
                    <span className="text-xs text-gray-500 font-medium uppercase tracking-wide">Editor</span>
                    <span className="badge-purple capitalize">{editorType}</span>
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
