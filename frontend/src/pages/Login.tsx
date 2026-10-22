import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import api from '../services/api';
import toast from 'react-hot-toast';
import { motion } from 'framer-motion';
import { ArrowRight, Loader2 } from 'lucide-react';
import { useThemeStore } from '../store/themeStore';
import { assetUrl } from '../constants/assets';

export default function Login() {
  const appName = useThemeStore(s => s.appName);
  const logoUrl = useThemeStore(s => s.logoUrl);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await api.post('/auth/login', { email, password });
      setAuth(res.data.user, res.data.access_token);
      toast.success('Welcome back!');
      if (res.data.user.must_change_password) {
        navigate('/change-password');
      } else {
        navigate('/');
      }
    } catch (err: any) {
      toast.error(err.response?.data?.detail || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden">
      {/* Animated gradient background */}
      <div className="absolute inset-0 bg-gradient-to-br from-brand-950 via-brand-900 to-accent-950" />
      <div className="absolute inset-0">
        <div className="absolute top-1/4 -left-20 w-96 h-96 bg-brand-500/20 rounded-full blur-3xl animate-pulse-soft" />
        <div className="absolute bottom-1/4 -right-20 w-96 h-96 bg-accent-500/20 rounded-full blur-3xl animate-pulse-soft" style={{ animationDelay: '1s' }} />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-brand-600/10 rounded-full blur-3xl" />
      </div>

      {/* Grid overlay */}
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:64px_64px]" />

      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        className="w-full max-w-md relative z-10 px-4"
      >
        <div className="glass-card bg-white/[0.08] border-white/[0.12] rounded-3xl p-8 shadow-2xl backdrop-blur-xl">
          {/* Logo & Header */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2, duration: 0.5 }}
            className="text-center mb-8"
          >
            <div className="bg-white rounded-2xl px-5 py-4 mb-6 shadow-lg shadow-black/20 border-b-4 border-highlight">
              <img src={assetUrl(logoUrl)} alt={appName} className="w-full h-auto max-h-24 object-contain" />
            </div>
            <h1 className="font-display text-2xl font-bold text-white tracking-tight">
              Welcome back
            </h1>
            <p className="text-brand-200/70 mt-1.5 text-sm">Sign in to {appName}</p>
          </motion.div>

          <motion.form
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3, duration: 0.5 }}
            onSubmit={handleSubmit}
            className="space-y-5"
          >
            <div>
              <label htmlFor="login-email" className="block text-xs font-medium text-brand-200/80 mb-1.5 ml-1">Email address</label>
              <input
                id="login-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-3 bg-white/[0.06] border border-white/[0.12] rounded-xl text-white placeholder-brand-300/50 focus:outline-none focus:ring-2 focus:ring-brand-400/60 focus:border-brand-400/60 focus:bg-white/[0.08] transition-all duration-200"
                placeholder="you@company.com"
                required
                autoComplete="email"
              />
            </div>
            <div>
              <label htmlFor="login-password" className="block text-xs font-medium text-brand-200/80 mb-1.5 ml-1">Password</label>
              <input
                id="login-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-3 bg-white/[0.06] border border-white/[0.12] rounded-xl text-white placeholder-brand-300/50 focus:outline-none focus:ring-2 focus:ring-brand-400/60 focus:border-brand-400/60 focus:bg-white/[0.08] transition-all duration-200"
                placeholder="••••••••"
                required
                autoComplete="current-password"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 px-4 bg-gradient-to-r from-brand-500 to-accent-500 hover:from-brand-400 hover:to-accent-400 text-white font-semibold rounded-xl shadow-lg shadow-brand-500/25 hover:shadow-xl hover:shadow-brand-500/30 active:scale-[0.98] transition-all duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-900 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <Loader2 size={18} className="animate-spin" />
                  Signing in…
                </>
              ) : (
                <>
                  Sign In
                  <ArrowRight size={16} />
                </>
              )}
            </button>
          </motion.form>

          {/* Footer */}
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5, duration: 0.5 }}
            className="text-center mt-6 text-xs text-brand-300/40"
          >
            Powered by {appName}
          </motion.p>
        </div>
      </motion.div>
    </div>
  );
}
