import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary] Caught error:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', height: '100%', padding: 40,
          color: 'var(--text-1, #999)', fontFamily: 'var(--font-sans, sans-serif)',
        }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>!</div>
          <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8, color: 'var(--text-0, #fff)' }}>
            Something went wrong
          </h2>
          <p style={{ fontSize: 14, marginBottom: 20, textAlign: 'center', maxWidth: 400 }}>
            {this.state.error?.message || 'An unexpected error occurred'}
          </p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              padding: '8px 24px', borderRadius: 8,
              background: 'var(--accent, #10b981)', color: '#fff',
              border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 500,
            }}
          >
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
