import React from 'react';
import { motion } from 'framer-motion';
import { Mic } from 'lucide-react';

interface SetupScreenProps {
    progress: number;
    status: string;
}

const SetupScreen: React.FC<SetupScreenProps> = ({ progress, status }) => {
    const isDownloading = progress > 0 && progress < 90;
    const isLoading = progress >= 90 && progress < 100;

    return (
        <div className="setup-screen">
            <div className="setup-content">
                {/* Icon */}
                <motion.div
                    className="setup-icon"
                    animate={{ scale: [1, 1.05, 1] }}
                    transition={{ repeat: Infinity, duration: 2, ease: 'easeInOut' }}
                >
                    <Mic size={28} />
                </motion.div>

                {/* Title */}
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

                {/* Progress bar */}
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
