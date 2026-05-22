/* ============================================================
   hub/HubApp.tsx — central-server (Hub) shell.

   Prototype only — drives off /hub/mockData. No backend yet.
   Replace the data layer with `/api/hub/*` later.
============================================================ */

import { Navigate, Route, Routes } from 'react-router-dom';
import { Cloud, Shield } from 'lucide-react';
import { HubDashboard } from './HubDashboard';
import { HostDetail } from './HostDetail';
import { useBodyScroll } from '../manager/toast';
import mgr from '../manager/manager.module.css';

export function HubApp() {
  useBodyScroll();
  return (
    <div className={mgr.page}>
      <HubTopBar />
      <Routes>
        <Route path="/" element={<Navigate to="/hub/dashboard" replace />} />
        <Route path="/dashboard"        element={<HubDashboard />} />
        <Route path="/hosts/:hostId"    element={<HostDetail />} />
        <Route path="*"                 element={<Navigate to="/hub/dashboard" replace />} />
      </Routes>
    </div>
  );
}

function HubTopBar() {
  return (
    <header className={mgr.topBar}>
      <span className={mgr.topBarTitle}>
        <Cloud size={15} strokeWidth={2} style={{ verticalAlign: -2, marginRight: 6, color: 'var(--accent-text)' }} />
        MetaBot <span className={mgr.topBarTitleAccent}>Hub</span>
      </span>
      <div className={mgr.topBarSpacer} />
      <span className={mgr.topBarUser}>
        <Shield size={14} strokeWidth={2} />
        <span>owner</span>
      </span>
    </header>
  );
}
