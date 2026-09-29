import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import api from '../services/api';
import type { Template, EditorType, ThemeConfig, MergeFieldDefinition } from '../types';
import toast from 'react-hot-toast';
import { Plus, Trash2, FileText, Edit, ArrowLeft, Save, Loader2 } from 'lucide-react';

import EditorSelector from '../components/EditorSelector';
import ConfirmDialog from '../components/ConfirmDialog';
import MergeFieldManager, { type MergeFieldDef } from '../components/MergeFieldManager';
import PreviewPane from '../editors/PreviewPane';
import PageContainer from '../components/ui/PageContainer';
import PageHeader from '../components/ui/PageHeader';
import EmptyState from '../components/ui/EmptyState';
import IconButton from '../components/ui/IconButton';
import StickyActionBar from '../components/ui/StickyActionBar';

type ViewMode = 'list' | 'create' | 'edit';

const container = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } };
const item = { hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: { duration: 0.3 } } };

function toCanonicalDefs(fields: MergeFieldDef[]): MergeFieldDefinition[] {
  return fields.map(f => ({
    key: f.name,
    label: f.label,
    data_type: 'text',
    required: false,
    default_value: f.defaultValue || null,
    source_kind: f.source === 'csv' ? 'uploaded_column' : 'custom',
    source_column: f.source === 'csv' ? f.name : null,
    is_system: false,
  }));
}

function fromCanonicalDefs(defs: MergeFieldDefinition[] | null | undefined): MergeFieldDef[] {
  if (!defs?.length) return [];
  return defs
    .filter(d => !d.is_system)
    .map(d => ({
      name: d.key,
      label: d.label,
      defaultValue: d.default_value || '',
      source: d.source_kind === 'uploaded_column' ? 'csv' as const : 'manual' as const,
    }));
}

/**
 * Template library. Two ways to design a template live side by side here:
 * the classic inline editor (below) and the new composer (`/composer/template/:code`),
 * opened from the "New Composer" button or a card's composer icon.
 */
export default function Templates() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<ViewMode>('list');
  const [saving, setSaving] = useState(false);
  const [deleteTemplateCode, setDeleteTemplateCode] = useState<string | null>(null);

  const [editCode, setEditCode] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [editorType, setEditorType] = useState<EditorType>('custom');
  const [htmlBody, setHtmlBody] = useState('');
  const [contentJson, setContentJson] = useState('');
  const [themeConfig, setThemeConfig] = useState<ThemeConfig | null>(null);
  const [mergeFields, setMergeFields] = useState<MergeFieldDef[]>([]);

  useEffect(() => { loadTemplates(); }, []);

  const loadTemplates = async () => {
    setLoading(true);
    try { const res = await api.get('/templates/'); setTemplates(res.data); }
    catch { toast.error('Failed to load templates'); }
    finally { setLoading(false); }
  };

  const resetForm = () => {
    setEditCode(null); setName(''); setDescription('');
    setEditorType('custom'); setHtmlBody(''); setContentJson(''); setThemeConfig(null);
    setMergeFields([]);
  };

  const openCreate = () => { resetForm(); setView('create'); };

  const openEdit = (t: Template) => {
    setEditCode(t.public_code); setName(t.name); setDescription(t.description || '');
    setEditorType(t.editor_type as EditorType); setHtmlBody(t.html_output || '');
    setContentJson(t.content_json || '');
    setThemeConfig(t.theme_config ? JSON.parse(t.theme_config) : null);
    setMergeFields(fromCanonicalDefs(t.merge_field_definitions_json));
    setView('edit');
  };

  const campaignMergeFields = useMemo(() => toCanonicalDefs(mergeFields), [mergeFields]);

  const handleSave = async () => {
    if (!name) { toast.error('Name is required'); return; }
    setSaving(true);
    try {
      const payload = {
        name,
        description: description || undefined,
        editor_type: editorType,
        content_json: contentJson || undefined,
        html_output: htmlBody || undefined,
        theme_config: themeConfig ? JSON.stringify(themeConfig) : undefined,
        merge_field_definitions_json: toCanonicalDefs(mergeFields),
      };
      if (editCode) { await api.patch(`/templates/${editCode}`, payload); toast.success('Template updated'); }
      else { await api.post('/templates/', payload); toast.success('Template created'); }
      setView('list'); resetForm(); loadTemplates();
    } catch (err: any) {
      toast.error(err.response?.data?.detail || 'Failed to save template');
    } finally { setSaving(false); }
  };

  const handleDelete = async (code: string) => {
    try {
      await api.delete(`/templates/${code}`);
      toast.success('Template deleted');
      loadTemplates();
    } catch (err: any) { toast.error(err.response?.data?.detail || 'Failed to delete'); }
    finally { setDeleteTemplateCode(null); }
  };

  // ─── Editor View (classic) ───
  if (view === 'create' || view === 'edit') {
    const closeEditor = () => { setView('list'); resetForm(); };

    return (
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
        <PageContainer className="space-y-6">
          <PageHeader
            title={view === 'edit' ? 'Edit Template' : 'Create Template'}
            subtitle="Design a reusable email body with merge fields"
            leading={
              <IconButton icon={ArrowLeft} label="Back to templates" onClick={closeEditor} />
            }
          />

          <div className="card-static p-6">
            <div className="grid grid-cols-1 gap-4">
              <div>
                <label htmlFor="tpl-name" className="block text-sm font-medium text-gray-700 mb-1.5">Template Name *</label>
                <input id="tpl-name" value={name} onChange={e => setName(e.target.value)} className="input-field" placeholder="Welcome Email" />
              </div>
              <div>
                <label htmlFor="tpl-description" className="block text-sm font-medium text-gray-700 mb-1.5">Description</label>
                <input id="tpl-description" value={description} onChange={e => setDescription(e.target.value)} className="input-field" placeholder="Brief description" />
              </div>
            </div>
          </div>

          <div className="card-static p-6">
            <h2 className="section-title mb-3">Merge Fields</h2>
            <p className="text-xs text-gray-500 mb-3">
              Define fields with optional default values. When this template is used in a campaign, defaults apply until CSV columns are mapped.
            </p>
            <MergeFieldManager fields={mergeFields} onChange={setMergeFields} />
          </div>

          <div className="card-static p-4 sm:p-6">
            <h2 className="section-title mb-4">Email Body</h2>
            <div className="flex flex-col min-h-[520px] h-[70vh] max-h-[900px]">
              <div className="flex-1 min-h-0">
                <EditorSelector
                  editorType={editorType}
                  onEditorTypeChange={setEditorType}
                  htmlBody={htmlBody}
                  onHtmlChange={setHtmlBody}
                  contentJson={contentJson}
                  onContentJsonChange={setContentJson}
                  mergeFields={mergeFields.map(f => ({ name: f.name, label: f.label }))}
                  themeConfig={themeConfig}
                  editorContext="template"
                  campaignMergeFields={campaignMergeFields}
                  onThemeChange={setThemeConfig}
                  sidePanel={
                    <div className="flex flex-col h-full min-h-0">
                      <div className="px-3 py-2 border-b border-gray-100 text-xs font-semibold text-gray-600">
                        Preview
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
        </PageContainer>

        <div className="mt-6">
          <StickyActionBar
            sticky
            left={<button type="button" onClick={closeEditor} disabled={saving} className="btn-secondary">Cancel</button>}
            center={
              !name ? (
                <span className="text-xs text-amber-600">Add a template name to save</span>
              ) : (
                <span className="text-xs text-gray-500">
                  {mergeFields.length} merge field{mergeFields.length !== 1 ? 's' : ''} defined
                </span>
              )
            }
            right={
              <button type="button" onClick={handleSave} disabled={saving || !name} className="btn-primary">
                {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                {saving ? 'Saving…' : view === 'edit' ? 'Update Template' : 'Save Template'}
              </button>
            }
          />
        </div>
      </motion.div>
    );
  }

  // ─── List View ───
  return (
    <PageContainer className="space-y-6">
      <PageHeader
        title="Email Templates"
        subtitle={loading ? 'Loading…' : `${templates.length} template${templates.length !== 1 ? 's' : ''}`}
        actions={
          <button type="button" onClick={openCreate} className="btn-primary"><Plus size={16} /> New Template</button>
        }
      />

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {[1, 2, 3].map(i => (
            <div key={i} className="card-static p-5 space-y-3">
              <div className="skeleton h-28 rounded-xl" />
              <div className="skeleton h-4 w-32" />
              <div className="skeleton h-3 w-20" />
            </div>
          ))}
        </div>
      ) : templates.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No templates yet"
          description="Create reusable email templates for your campaigns."
          iconTone="bg-gradient-to-br from-accent-100 to-pink-100"
          iconColor="text-accent-500"
          action={
            <button type="button" onClick={openCreate} className="btn-primary"><Plus size={16} /> Create Template</button>
          }
        />
      ) : (
        <motion.div variants={container} initial="hidden" animate="show"
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {templates.map(template => (
            <motion.div key={template.public_code} variants={item}>
              <div className="card group p-5">
                <div className="flex items-start justify-between mb-3 gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-semibold text-gray-900 truncate group-hover:text-brand-600 transition-colors">{template.name}</h3>
                      <span className="font-mono text-[11px] text-gray-500">{template.public_code}</span>
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5 truncate">{template.description || 'No description'}</p>
                  </div>
                  <div className="flex gap-0.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    <IconButton icon={Edit} label={`Edit ${template.name}`} tone="brand" size="sm" onClick={() => openEdit(template)} />
                    <IconButton icon={Trash2} label={`Delete ${template.name}`} tone="danger" size="sm" onClick={() => setDeleteTemplateCode(template.public_code)} />
                  </div>
                </div>

                {template.html_output ? (
                  <div className="border border-gray-100 rounded-xl overflow-hidden h-32 bg-gray-50">
                    <iframe srcDoc={template.html_output} className="w-full h-full border-0 pointer-events-none" title={`${template.name} preview`} sandbox="" />
                  </div>
                ) : (
                  <div className="h-32 bg-gray-50 rounded-xl flex items-center justify-center">
                    <FileText size={24} className="text-gray-300" />
                  </div>
                )}

                <div className="flex items-center gap-2 mt-3 flex-wrap">
                  <span className="badge-gray capitalize text-[10px]">{template.editor_type}</span>
                  {(template.merge_field_definitions_json?.length || 0) > 0 && (
                    <span className="badge-gray text-[10px]">
                      {template.merge_field_definitions_json!.length} fields
                    </span>
                  )}
                </div>
              </div>
            </motion.div>
          ))}
        </motion.div>
      )}

      <ConfirmDialog
        open={deleteTemplateCode !== null}
        title="Delete Template"
        message="Are you sure you want to delete this template? This cannot be undone."
        confirmLabel="Delete"
        onConfirm={() => deleteTemplateCode && handleDelete(deleteTemplateCode)}
        onCancel={() => setDeleteTemplateCode(null)}
      />
    </PageContainer>
  );
}
