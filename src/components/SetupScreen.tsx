import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Mic, Shield, Check } from 'lucide-react';

interface SetupScreenProps {
    progress: number;
    status: string;
    onSetupComplete: () => void;
}

type SetupPhase = 'downloading' | 'permissions' | 'ready';

const SetupScreen: React.FC<SetupScreenProps> = ({ progress, status, onSetupComplete }) => {
    const [phase, setPhase] = useState<SetupPhase>('downloading');
    const [micGranted, setMicGranted] = useState(false);
    const [accessGranted, setAccessGranted] = useState(false);
    const [permissionsDone, setPermissionsDone] = useState(false);

    // When model is ready (progress >= 100), move to permissions phase
    useEffect(() => {
        if (progress >= 100 && phase === 'downloading') {
            setPhase('permissions');
        }
    }, [progress, phase]);

    // When mic is granted, auto-complete after a brief delay
    // (accessibility is optional — paste-to-target vs clipboard-only)
    useEffect(() => {
        if (micGranted && !permissionsDone) {
            setPermissionsDone(true);
            setTimeout(() => {
                window.electronAPI?.setupComplete({ accessibilityGranted: accessGranted });
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
        window.electronAPI?.setupComplete({ accessibilityGranted: false });
        onSetupComplete();
    };

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
                        <p className="setup-perm-hint">Required to capture your voice</p>

                        <button
                            className={`setup-perm-btn ${accessGranted ? 'granted' : ''}`}
                            onClick={requestAccess}
                            disabled={accessGranted}
                        >
                            {accessGranted ? <Check size={14} /> : <Shield size={14} />}
                            <span>{accessGranted ? 'Accessibility ✓' : 'Allow Paste Access'}</span>
                        </button>
                        <p className="setup-perm-hint">Lets Clarity Scribe paste into your active app</p>
                    </div>

                    <button className="setup-skip-btn" onClick={skipPermissions}>
                        Skip for now
                    </button>
                </div>
            </div>
        );
    }

    // Downloading phase
    const isDownloading = progress > 0 && progress < 90;
    const isLoading = progress >= 90 && progress < 100;

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
                <p className="setup-subtitle">
                    {progress === 0
                        ? 'Preparing transcription engine...'
                        : isDownloading
                            ? 'Downloading Whisper AI model (~1.5 GB)'
                            : isLoading
                                ? 'Loading model into memory...'
                                : 'Almost ready...'}
                </p>

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

                {isDownloading && (
                    <p className="setup-hint">
                        This only happens once. The model is stored locally for offline use.
                    </p>
                )}
            </div>
        </div>
    );
};

export default SetupScreen;
