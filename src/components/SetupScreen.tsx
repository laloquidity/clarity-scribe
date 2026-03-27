import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mic, Shield, Check, Download, Brain, AudioWaveform } from 'lucide-react';

interface SetupScreenProps {
    progress: number;
    status: string;
    onSetupComplete: () => void;
}

interface SetupStep {
    id: string;
    label: string;
    percent: number;
    status: string;
}

type SetupPhase = 'downloading' | 'permissions' | 'ready';

const SetupScreen: React.FC<SetupScreenProps> = ({ progress, status, onSetupComplete }) => {
    const [phase, setPhase] = useState<SetupPhase>('downloading');
    const [micGranted, setMicGranted] = useState(false);
    const [accessGranted, setAccessGranted] = useState(false);
    const [permissionsDone, setPermissionsDone] = useState(false);
    const [isWindows, setIsWindows] = useState(false);
    const [steps, setSteps] = useState<Record<string, SetupStep>>({});

    // Detect platform
    useEffect(() => {
        window.electronAPI?.getPlatform?.().then((p: string) => {
            setIsWindows(p === 'win32');
        });
    }, []);

    // Listen for per-step progress
    useEffect(() => {
        const unsub = window.electronAPI?.onSetupStepProgress?.((step) => {
            setSteps(prev => ({ ...prev, [step.id]: step }));
        });
        return () => { unsub?.(); };
    }, []);

    // When all models ready, move to permissions or complete
    useEffect(() => {
        if (progress >= 100 && phase === 'downloading') {
            if (isWindows) {
                window.electronAPI?.setupComplete();
                onSetupComplete();
            } else {
                setPhase('permissions');
            }
        }
    }, [progress, phase, isWindows, onSetupComplete]);

    // When permissions granted, complete setup
    useEffect(() => {
        if (micGranted && accessGranted && !permissionsDone) {
            setPermissionsDone(true);
            setTimeout(() => {
                window.electronAPI?.setupComplete();
                onSetupComplete();
            }, 800);
        }
    }, [micGranted, accessGranted, permissionsDone, onSetupComplete]);

    const requestMic = async () => {
        const result = await window.electronAPI?.requestMicPermission();
        setMicGranted(result === 'granted');
    };

    const requestAccess = async () => {
        const result = await window.electronAPI?.requestAccessibilityPermission();
        setAccessGranted(result === 'granted');
    };

    const skipPermissions = () => {
        window.electronAPI?.setupComplete();
        onSetupComplete();
    };

    const getStepIcon = (step: SetupStep) => {
        if (step.percent >= 100) return <Check size={12} />;
        if (step.id === 'whisper') return <Brain size={12} />;
        if (step.id === 'vad') return <AudioWaveform size={12} />;
        return <Download size={12} />;
    };

    const stepOrder = ['whisper', 'vad', 'parakeet'];
    const activeSteps = stepOrder.filter(id => steps[id]);

    if (phase === 'permissions') {
        return (
            <div className="setup-screen">
                <div className="setup-content">
                    <motion.div
                        className="setup-icon"
                        initial={{ scale: 0.8, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ duration: 0.3 }}
                    >
                        <Shield size={28} />
                    </motion.div>

                    <h1 className="setup-title">Permissions</h1>
                    <p className="setup-subtitle">
                        Clarity Scribe needs a couple permissions to work properly.
                    </p>

                    <div className="setup-permissions">
                        <button
                            className={`setup-perm-btn ${micGranted ? 'granted' : ''}`}
                            onClick={requestMic}
                            disabled={micGranted}
                        >
                            {micGranted ? <Check size={14} /> : <Mic size={14} />}
                            <span>{micGranted ? 'Microphone ✓' : 'Allow Microphone'}</span>
                        </button>
                        <p className="setup-perm-hint">Required to hear your voice for transcription</p>

                        <button
                            className={`setup-perm-btn ${accessGranted ? 'granted' : ''}`}
                            onClick={requestAccess}
                            disabled={accessGranted}
                        >
                            {accessGranted ? <Check size={14} /> : <Shield size={14} />}
                            <span>{accessGranted ? 'Accessibility ✓' : 'Allow Paste Access'}</span>
                        </button>
                        <p className="setup-perm-hint">Required to auto-paste text into your active app</p>
                    </div>

                    <button className="setup-skip-btn" onClick={skipPermissions}>
                        Skip for now
                    </button>
                </div>
            </div>
        );
    }

    // Calculate overall progress from steps
    const totalSteps = 3;
    const completedSteps = activeSteps.filter(id => steps[id]?.percent >= 100).length;
    const currentStepId = activeSteps.find(id => steps[id] && steps[id].percent < 100) || activeSteps[activeSteps.length - 1];
    const currentStep = currentStepId ? steps[currentStepId] : null;

    return (
        <div className="setup-screen">
            <div className="setup-content">
                <motion.div
                    className="setup-icon"
                    animate={{ scale: [1, 1.05, 1] }}
                    transition={{ repeat: Infinity, duration: 2, ease: 'easeInOut' }}
                >
                    <Mic size={28} />
                </motion.div>

                <h1 className="setup-title">Setting up Clarity Scribe</h1>
                <p className="setup-subtitle" style={{ marginBottom: 4 }}>
                    {activeSteps.length === 0
                        ? 'Preparing…'
                        : completedSteps >= totalSteps
                            ? 'Almost ready…'
                            : 'Downloading models for offline use'}
                </p>

                {/* Step list */}
                <div style={{
                    width: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    marginTop: 4,
                }}>
                    <AnimatePresence>
                        {activeSteps.map((id) => {
                            const step = steps[id];
                            if (!step) return null;
                            const isDone = step.percent >= 100;
                            const isActive = id === currentStepId && !isDone;
                            return (
                                <motion.div
                                    key={id}
                                    initial={{ opacity: 0, y: 8 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ duration: 0.25 }}
                                    style={{
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: 4,
                                        padding: '8px 10px',
                                        borderRadius: 8,
                                        background: isDone
                                            ? 'rgba(34, 197, 94, 0.05)'
                                            : isActive
                                                ? 'rgba(124, 91, 245, 0.06)'
                                                : 'rgba(255, 255, 255, 0.02)',
                                        border: `1px solid ${
                                            isDone
                                                ? 'rgba(34, 197, 94, 0.15)'
                                                : isActive
                                                    ? 'rgba(124, 91, 245, 0.15)'
                                                    : 'rgba(255, 255, 255, 0.04)'
                                        }`,
                                        transition: 'all 0.3s ease',
                                    }}
                                >
                                    <div style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 8,
                                    }}>
                                        <div style={{
                                            width: 22,
                                            height: 22,
                                            borderRadius: '50%',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            background: isDone
                                                ? 'rgba(34, 197, 94, 0.15)'
                                                : 'rgba(124, 91, 245, 0.1)',
                                            color: isDone ? '#22c55e' : 'var(--primary)',
                                            flexShrink: 0,
                                        }}>
                                            {getStepIcon(step)}
                                        </div>
                                        <span style={{
                                            flex: 1,
                                            fontSize: 11,
                                            fontWeight: 600,
                                            color: isDone ? '#22c55e' : 'var(--text-primary)',
                                        }}>
                                            {step.label}
                                        </span>
                                        <span style={{
                                            fontSize: 10,
                                            fontFamily: 'monospace',
                                            fontWeight: 600,
                                            color: isDone ? '#22c55e' : 'var(--text-muted)',
                                        }}>
                                            {isDone ? '✓' : `${step.percent}%`}
                                        </span>
                                    </div>

                                    {/* Progress bar — only show while active */}
                                    {isActive && (
                                        <div style={{
                                            width: '100%',
                                            height: 3,
                                            borderRadius: 2,
                                            background: 'rgba(255, 255, 255, 0.06)',
                                            overflow: 'hidden',
                                        }}>
                                            <motion.div
                                                style={{
                                                    height: '100%',
                                                    background: 'linear-gradient(90deg, var(--primary), #a78bfa)',
                                                    borderRadius: 2,
                                                }}
                                                initial={{ width: 0 }}
                                                animate={{ width: `${step.percent}%` }}
                                                transition={{ duration: 0.3, ease: 'easeOut' }}
                                            />
                                        </div>
                                    )}

                                    {/* Status text */}
                                    {isActive && step.status && step.status !== 'Preparing...' && (
                                        <span style={{
                                            fontSize: 9,
                                            color: 'var(--text-muted)',
                                            paddingLeft: 30,
                                        }}>
                                            {step.status}
                                        </span>
                                    )}
                                </motion.div>
                            );
                        })}
                    </AnimatePresence>
                </div>

                {/* Fallback: show old-style progress if no steps received */}
                {activeSteps.length === 0 && progress > 0 && (
                    <>
                        <div className="setup-progress-track">
                            <motion.div
                                className="setup-progress-fill"
                                initial={{ width: 0 }}
                                animate={{ width: `${progress}%` }}
                                transition={{ duration: 0.3, ease: 'easeOut' }}
                            />
                        </div>
                        <span className="setup-percent">
                            {status || `${progress}%`}
                        </span>
                    </>
                )}

                <p className="setup-hint" style={{ marginTop: 6 }}>
                    This only happens once. Everything runs offline after setup.
                </p>
            </div>
        </div>
    );
};

export default SetupScreen;
