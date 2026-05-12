import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
    children: ReactNode;
}

interface State {
    error: Error | null;
    info: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
    state: State = { error: null, info: null };

    static getDerivedStateFromError(error: Error): Partial<State> {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo): void {
        this.setState({ info });
        console.error('Unhandled render error:', error, info);
    }

    private reset = () => this.setState({ error: null, info: null });

    render() {
        const { error, info } = this.state;
        if (!error) return this.props.children;

        return (
            <div className="h-screen w-screen overflow-auto bg-neutral-900 text-gray-100 p-6 font-mono text-sm">
                <div className="max-w-4xl mx-auto">
                    <h1 className="text-lg font-semibold text-red-400 mb-2">Forge SQL crashed while rendering</h1>
                    <p className="text-xs text-neutral-400 mb-4">
                        The error below was caught by the top-level boundary. Copy the stack trace when reporting.
                    </p>
                    <div className="rounded-md border border-red-800/50 bg-red-950/40 p-3 mb-4">
                        <p className="text-red-300 font-semibold mb-2">{error.name}: {error.message}</p>
                        {error.stack && (
                            <pre className="text-xs text-red-200 whitespace-pre-wrap break-words">{error.stack}</pre>
                        )}
                    </div>
                    {info?.componentStack && (
                        <details className="rounded-md border border-neutral-700 bg-neutral-800/60 p-3">
                            <summary className="cursor-pointer text-neutral-300">Component stack</summary>
                            <pre className="mt-2 text-xs text-neutral-400 whitespace-pre-wrap break-words">
                                {info.componentStack}
                            </pre>
                        </details>
                    )}
                    <button
                        onClick={this.reset}
                        className="mt-4 px-3 py-1.5 text-xs rounded border border-neutral-600 text-neutral-200 hover:bg-neutral-800"
                    >
                        Try to recover
                    </button>
                </div>
            </div>
        );
    }
}
