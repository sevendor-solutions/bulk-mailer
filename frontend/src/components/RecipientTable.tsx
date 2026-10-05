import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, Loader2, CheckSquare, Square } from 'lucide-react';
import api from '../services/api';
import toast from 'react-hot-toast';

export interface RecipientRow {
  public_code: string;
  email: string;
  name: string;
  merge_data: Record<string, string>;
  is_included: boolean;
  status: string;
  error_message?: string | null;
  row_index?: number | null;
  sent_at?: string | null;
  retry_count?: number;
  next_attempt_at?: string | null;
}

interface Props {
  campaignCode: string;
  /** Optional status filter for drill-down. Several statuses may be comma-separated. */
  status?: string;
  onCountsChange?: (included: number, total: number) => void;
  readOnly?: boolean;
  /** Change this to reload the current page quietly, e.g. while a campaign is sending. */
  refreshKey?: string | number;
}

const STATUS_STYLE: Record<string, string> = {
  pending: 'bg-gray-100 text-gray-700',
  sending: 'bg-amber-50 text-amber-700',
  sent: 'bg-emerald-50 text-emerald-700',
  failed: 'bg-red-50 text-red-700',
  bounced: 'bg-red-50 text-red-700',
  unsubscribed: 'bg-orange-50 text-orange-700',
};

function statusLabel(row: RecipientRow) {
  if (row.status === 'pending' && row.next_attempt_at) return 'Waiting to retry';
  return row.status;
}

function details(row: RecipientRow) {
  if (row.status === 'sent' && row.sent_at) return `Sent ${new Date(row.sent_at).toLocaleString()}`;
  if (row.status === 'pending' && row.next_attempt_at) {
    const at = new Date(row.next_attempt_at).toLocaleTimeString();
    return `Attempt ${row.retry_count ?? 0} failed, retrying after ${at}: ${row.error_message || 'unknown error'}`;
  }
  if (row.error_message && row.status !== 'sent') return row.error_message;
  return '';
}

export default function RecipientTable({
  campaignCode,
  status,
  onCountsChange,
  readOnly = false,
  refreshKey,
}: Props) {
  const [items, setItems] = useState<RecipientRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [includedFilter, setIncludedFilter] = useState<'all' | 'included' | 'excluded'>('all');
  const pageSize = 50;
  // Only the newest request may update the table
  const requestId = useRef(0);

  const load = useCallback(async (quiet = false) => {
    const id = ++requestId.current;
    if (!quiet) setLoading(true);
    try {
      const params: Record<string, string | number | boolean> = {
        page,
        page_size: pageSize,
      };
      if (search) params.q = search;
      if (status) params.status = status;
      if (includedFilter === 'included') params.included = true;
      if (includedFilter === 'excluded') params.included = false;

      const res = await api.get(`/campaigns/${campaignCode}/recipients`, { params });
      if (id !== requestId.current) return;
      setItems(res.data.items || []);
      setTotal(res.data.total || 0);

      if (onCountsChange) {
        const summary = await api.get(`/campaigns/${campaignCode}/recipients/summary`);
        onCountsChange(summary.data.included ?? 0, summary.data.total ?? 0);
      }
    } catch {
      if (!quiet) toast.error('Failed to load recipients');
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [campaignCode, page, search, status, includedFilter, onCountsChange]);

  useEffect(() => { load(); }, [load]);

  // Quiet reload when the parent signals that the data moved
  const firstRefresh = useRef(true);
  useEffect(() => {
    if (firstRefresh.current) { firstRefresh.current = false; return; }
    load(true);
  }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // A different filter starts again from the first page
  useEffect(() => { setPage(1); }, [status]);

  useEffect(() => {
    const t = setTimeout(() => { setSearch(q); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const toggleOne = async (row: RecipientRow) => {
    if (readOnly) return;
    try {
      await api.patch(`/campaigns/${campaignCode}/recipients/inclusion`, {
        is_included: !row.is_included,
        codes: [row.public_code],
      });
      await load();
    } catch {
      toast.error('Failed to update inclusion');
    }
  };

  const togglePage = async (include: boolean) => {
    if (readOnly) return;
    try {
      await api.patch(`/campaigns/${campaignCode}/recipients/inclusion`, {
        is_included: include,
        codes: items.map(i => i.public_code),
      });
      await load();
    } catch {
      toast.error('Failed to update inclusion');
    }
  };

  const selectAllMatching = async (include: boolean) => {
    if (readOnly) return;
    try {
      await api.patch(`/campaigns/${campaignCode}/recipients/inclusion`, {
        is_included: include,
        all: true,
      });
      await load();
      toast.success(include ? 'All recipients included' : 'All recipients excluded');
    } catch {
      toast.error('Failed to update inclusion');
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const allPageIncluded = items.length > 0 && items.every(i => i.is_included);
  // Select + four columns when editable, four columns + details when read-only
  const columnCount = 5;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search email or code…"
            aria-label="Search recipients"
            className="input-field pl-9 py-2 text-sm"
          />
        </div>
        {!status && (
          <select
            value={includedFilter}
            onChange={e => { setIncludedFilter(e.target.value as typeof includedFilter); setPage(1); }}
            className="input-field py-2 text-sm w-auto"
            aria-label="Filter by inclusion"
          >
            <option value="all">All</option>
            <option value="included">Included</option>
            <option value="excluded">Excluded</option>
          </select>
        )}
        {!readOnly && (
          <div className="flex gap-1">
            <button type="button" onClick={() => togglePage(!allPageIncluded)} className="btn-secondary btn-sm">
              {allPageIncluded ? 'Exclude page' : 'Include page'}
            </button>
            <button type="button" onClick={() => selectAllMatching(true)} className="btn-secondary btn-sm">
              Include all
            </button>
            <button type="button" onClick={() => selectAllMatching(false)} className="btn-secondary btn-sm">
              Exclude all
            </button>
          </div>
        )}
      </div>

      <div className="border border-gray-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-500 uppercase tracking-wide">
              <tr>
                {!readOnly && <th className="px-3 py-2.5 w-10" />}
                <th className="px-3 py-2.5">ID</th>
                <th className="px-3 py-2.5">Email</th>
                <th className="px-3 py-2.5">Name</th>
                <th className="px-3 py-2.5">Status</th>
                {readOnly && <th className="px-3 py-2.5">Details</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={columnCount} className="px-3 py-10 text-center text-gray-500">
                    <Loader2 size={20} className="animate-spin inline mr-2" /> Loading…
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={columnCount} className="px-3 py-10 text-center text-gray-500">No recipients found</td>
                </tr>
              ) : (
                items.map(row => (
                  <tr key={row.public_code} className={!row.is_included ? 'bg-gray-50/80 opacity-70' : ''}>
                    {!readOnly && (
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          onClick={() => toggleOne(row)}
                          className="text-brand-600 hover:text-brand-700 cursor-pointer"
                          aria-label={row.is_included ? `Exclude ${row.email}` : `Include ${row.email}`}
                        >
                          {row.is_included ? <CheckSquare size={16} /> : <Square size={16} />}
                        </button>
                      </td>
                    )}
                    <td className="px-3 py-2 font-mono text-[11px] text-gray-500 whitespace-nowrap">{row.public_code}</td>
                    <td className="px-3 py-2 text-gray-900">{row.email}</td>
                    <td className="px-3 py-2 text-gray-600">
                      {row.name || (row.merge_data && (
                        row.merge_data.name ||
                        row.merge_data.Name ||
                        row.merge_data.full_name ||
                        row.merge_data.FullName ||
                        row.merge_data.first_name ||
                        row.merge_data.FirstName ||
                        row.merge_data.contact_name
                      )) || '—'}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium capitalize ${STATUS_STYLE[row.status] || STATUS_STYLE.pending}`}>
                        {statusLabel(row)}
                      </span>
                      {!row.is_included && <span className="ml-1.5 text-xs text-gray-500">excluded</span>}
                    </td>
                    {readOnly && (
                      <td
                        className={`px-3 py-2 text-xs max-w-[320px] truncate ${row.status === 'sent' ? 'text-gray-500' : 'text-red-600'}`}
                        title={details(row)}
                      >
                        {details(row) || '—'}
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex items-center justify-between text-xs text-gray-500">
        <span>{total.toLocaleString()} recipient{total !== 1 ? 's' : ''}</span>
        <div className="flex items-center gap-2">
          <button type="button" disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="btn-secondary btn-sm disabled:opacity-40">
            Prev
          </button>
          <span>Page {page} / {totalPages}</span>
          <button type="button" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)} className="btn-secondary btn-sm disabled:opacity-40">
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
