import React, { Suspense } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { LoginButton } from '@/components/LoginButton/LoginButton';
import { LoginModal } from '@/components/LoginModal/LoginModal';
import { Logo, LogoVariant } from '@/components/Logo';
import { NetworkStatus } from '@/components/NetworkStatus/NetworkStatus';
import { DEBUG_PANEL_ENABLED } from '@/components/Stream/SwarmHlsPlayer/debug/debugLog';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import { useTheme } from '@/providers/Theme';
import { useUserContext } from '@/providers/User';
import { ROUTES } from '@/routes';
import { AVAILABLE_THEMES } from '@/utils/theme/themeConfig';

import './MainLayout.scss';

// Debug build only (VITE_DEBUG_PANEL=true): the segment/playlist timing panel, on stream pages; kept out of normal bundles.
const DebugPanel = DEBUG_PANEL_ENABLED
  ? React.lazy(() => import('@/components/Stream/SwarmHlsPlayer/debug/DebugPanel'))
  : null;

interface MainLayoutProps {
  children: React.ReactNode;
}

export function MainLayout({ children }: MainLayoutProps) {
  const { isOnline } = useNetworkStatus(); // TODO - reanable
  const { isLoginModalOpen } = useUserContext();
  const { theme } = useTheme();
  const { pathname } = useLocation();
  const onStreamPage = pathname.startsWith('/watch/');

  const { backgroundVideoPath } = AVAILABLE_THEMES[theme];

  return (
    <div className="main-layout" role="main-layout">
      {backgroundVideoPath && (
        <video className="main-layout__background-video" src={backgroundVideoPath} autoPlay muted playsInline />
      )}
      <NetworkStatus isOnline={true} />
      <header>
        <Link to={ROUTES.STREAM_BROWSER} className="logo-link" aria-label="Go to stream browser">
          <Logo className="logo logo--desktop" />
          <Logo variant={LogoVariant.ICON} className="logo logo--mobile" />
        </Link>
        <LoginButton />
      </header>
      {isLoginModalOpen && <LoginModal />}
      {DebugPanel && onStreamPage && (
        <Suspense fallback={null}>
          <DebugPanel />
        </Suspense>
      )}
      <div className="content">{children}</div>
    </div>
  );
}
