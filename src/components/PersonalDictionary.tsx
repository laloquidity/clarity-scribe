import React, { useState, useEffect, useRef } from 'react';
import { X, Plus, Trash2, Book, ArrowRight, Pencil, CheckSquare, Square, Download, Upload } from 'lucide-react';
import type { DictionaryEntry } from '../types';
import { generateVariants } from '../types';

interface PersonalDictionaryProps {
    isOpen: boolean;
    onClose: () => void;
    dictionary: DictionaryEntry[];
    onUpdate: (dictionary: DictionaryEntry[]) => void;
}

export const PersonalDictionary: React.FC<PersonalDictionaryProps> = ({
    isOpen,
    onClose,
    dictionary,
    onUpdate,
}) => {
    const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
    const [isSelectMode, setIsSelectMode] = useState(false);
    const [isAdding, setIsAdding] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [original, setOriginal] = useState('');
    const [replacement, setReplacement] = useState('');
    const originalInputRef = useRef<HTMLInputElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if ((isAdding || isEditing) && originalInputRef.current) {
            originalInputRef.current.focus();
        }
    }, [isAdding, isEditing]);

    // Exit select mode when panel closes
    useEffect(() => {
        if (!isOpen) {
            setIsSelectMode(false);
            setSelectedItems(new Set());
        }
    }, [isOpen]);

    if (!isOpen) return null;

    const resetForm = () => {
        setOriginal('');
        setReplacement('');
        setIsAdding(false);
        setIsEditing(false);
        setEditingId(null);
    };

    const handleAdd = () => {
        if (original.trim() && replacement.trim()) {
            const newEntry: DictionaryEntry = {
                id: crypto.randomUUID(),
                original: original.trim(),
                replacement: replacement.trim(),
                variants: generateVariants(original.trim()),
                createdAt: Date.now(),
            };

            const exists = dictionary.some(
                e => e.original.toLowerCase() === newEntry.original.toLowerCase() && e.id !== editingId
            );

            if (!exists) {
                onUpdate([...dictionary, newEntry]);
                resetForm();
            }
        }
    };

    const handleEdit = () => {
        if (selectedItems.size === 1) {
            const id = [...selectedItems][0];
            const entry = dictionary.find(e => e.id === id);
            if (entry) {
                setEditingId(id);
                setOriginal(entry.original);
                setReplacement(entry.replacement);
                setIsEditing(true);
                setIsSelectMode(false);
            }
        }
    };

    const handleEditSave = () => {
        if (original.trim() && replacement.trim() && editingId) {
            const exists = dictionary.some(
                e => e.original.toLowerCase() === original.trim().toLowerCase() && e.id !== editingId
            );

            if (!exists) {
                const updatedDict = dictionary.map(e => {
                    if (e.id === editingId) {
                        return {
                            ...e,
                            original: original.trim(),
                            replacement: replacement.trim(),
                            variants: generateVariants(original.trim()),
                        };
                    }
                    return e;
                });
                onUpdate(updatedDict);
                resetForm();
                setSelectedItems(new Set());
            }
        }
    };

    const handleDelete = () => {
        const newDict = dictionary.filter(e => !selectedItems.has(e.id));
        onUpdate(newDict);
        setSelectedItems(new Set());
        if (newDict.length === 0) {
            setIsSelectMode(false);
        }
    };

    const handleItemClick = (id: string) => {
        if (isSelectMode) {
            const newSelected = new Set(selectedItems);
            if (newSelected.has(id)) {
                newSelected.delete(id);
            } else {
                newSelected.add(id);
            }
            setSelectedItems(newSelected);
        } else {
            // Single select toggle
            const newSelected = new Set(selectedItems);
            if (newSelected.has(id)) {
                newSelected.delete(id);
            } else {
                newSelected.clear();
                newSelected.add(id);
            }
            setSelectedItems(newSelected);
        }
    };

    const handleSelectAll = () => {
        if (selectedItems.size === dictionary.length) {
            setSelectedItems(new Set());
        } else {
            setSelectedItems(new Set(dictionary.map(e => e.id)));
        }
    };

    const toggleSelectMode = () => {
        if (isSelectMode) {
            setIsSelectMode(false);
            setSelectedItems(new Set());
        } else {
            setIsSelectMode(true);
        }
    };

    // Export dictionary to JSON file
    const handleExport = () => {
        const data = JSON.stringify(dictionary, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `clarity-dictionary-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    // Import dictionary from JSON file
    const handleImport = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const imported = JSON.parse(e.target?.result as string) as DictionaryEntry[];
                if (Array.isArray(imported)) {
                    // Merge: add imported entries that don't already exist
                    const existingOriginals = new Set(dictionary.map(d => d.original.toLowerCase()));
                    const newEntries = imported.filter(
                        entry => entry.original && entry.replacement && !existingOriginals.has(entry.original.toLowerCase())
                    ).map(entry => ({
                        ...entry,
                        id: entry.id || crypto.randomUUID(),
                        variants: entry.variants || generateVariants(entry.original),
                        createdAt: entry.createdAt || Date.now(),
                    }));

                    if (newEntries.length > 0) {
                        onUpdate([...dictionary, ...newEntries]);
                        alert(`Imported ${newEntries.length} new correction${newEntries.length !== 1 ? 's' : ''}`);
                    } else {
                        alert('No new corrections to import (all already exist)');
                    }
                }
            } catch {
                alert('Invalid file format. Please select a valid dictionary JSON file.');
            }
        };
        reader.readAsText(file);
        // Reset input so same file can be selected again
        event.target.value = '';
    };

    const showForm = isAdding || isEditing;
    const allSelected = dictionary.length > 0 && selectedItems.size === dictionary.length;

    return (
        <div className="dictionary-panel">

            {/* Hidden file input for import */}
            <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                onChange={handleImport}
                className="hidden"
                style={{ display: 'none' }}
            />

            {/* Header */}
            <div className="dictionary-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Book className="dictionary-icon" size={16} />
                    <div>
                        <h2 className="dictionary-title">Personal Dictionary</h2>
                        <p className="dictionary-subtitle">Correct misheard words automatically</p>
                    </div>
                </div>
                <button onClick={onClose} className="dictionary-close-btn">
                    <X size={14} />
                </button>
            </div>

            {/* Actions Row */}
            <div className="dictionary-actions">
                <button
                    onClick={() => { resetForm(); setIsAdding(true); setIsSelectMode(false); }}
                    className="dict-btn dict-btn-primary"
                >
                    <Plus size={12} />
                    Add
                </button>

                {dictionary.length > 0 && (
                    <button
                        onClick={toggleSelectMode}
                        className={`dict-btn ${isSelectMode ? 'dict-btn-active' : 'dict-btn-secondary'}`}
                    >
                        <CheckSquare size={12} />
                        {isSelectMode ? 'Done' : 'Select'}
                    </button>
                )}

                {isSelectMode && dictionary.length > 0 && (
                    <button onClick={handleSelectAll} className="dict-btn dict-btn-secondary">
                        {allSelected ? <CheckSquare size={12} /> : <Square size={12} />}
                        {allSelected ? 'Deselect All' : 'Select All'}
                    </button>
                )}

                {!isSelectMode && selectedItems.size === 1 && (
                    <button onClick={handleEdit} className="dict-btn dict-btn-secondary">
                        <Pencil size={12} />
                        Edit
                    </button>
                )}

                {selectedItems.size > 0 && (
                    <button onClick={handleDelete} className="dict-btn dict-btn-danger">
                        <Trash2 size={12} />
                        Delete ({selectedItems.size})
                    </button>
                )}
            </div>

            {/* Add/Edit Correction Form */}
            {showForm && (
                <div className="dictionary-form">
                    <span className="dictionary-form-label">
                        {isEditing ? 'Edit Correction' : 'New Correction'}
                    </span>
                    <div className="dictionary-form-row">
                        <div className="dictionary-form-field">
                            <label className="dictionary-field-label">What was written:</label>
                            <input
                                ref={originalInputRef}
                                type="text"
                                value={original}
                                onChange={(e) => setOriginal(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Escape') resetForm(); }}
                                className="dictionary-input"
                                placeholder="e.g., Chat GPT"
                            />
                        </div>
                        <ArrowRight size={14} style={{ color: 'var(--text-tertiary)', marginTop: 18, flexShrink: 0 }} />
                        <div className="dictionary-form-field">
                            <label className="dictionary-field-label">What you meant:</label>
                            <input
                                type="text"
                                value={replacement}
                                onChange={(e) => setReplacement(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') isEditing ? handleEditSave() : handleAdd();
                                    if (e.key === 'Escape') resetForm();
                                }}
                                className="dictionary-input"
                                placeholder="e.g., ChatGPT"
                            />
                        </div>
                    </div>
                    <div className="dictionary-form-actions">
                        <button onClick={resetForm} className="dict-btn-text">Cancel</button>
                        <button
                            onClick={isEditing ? handleEditSave : handleAdd}
                            disabled={!original.trim() || !replacement.trim()}
                            className="dict-btn dict-btn-submit"
                        >
                            {isEditing ? 'Save' : 'Add'}
                        </button>
                    </div>
                    {original.trim() && (
                        <p className="dictionary-variants-preview">
                            Will also match: {generateVariants(original.trim()).slice(0, 3).join(', ')}
                            {generateVariants(original.trim()).length > 3 && '...'}
                        </p>
                    )}
                </div>
            )}

            {/* Dictionary List */}
            <div className="dictionary-list">
                {dictionary.length === 0 ? (
                    <div className="dictionary-empty">
                        <Book size={20} style={{ opacity: 0.4, marginBottom: 8 }} />
                        <p className="dictionary-empty-title">No corrections added yet</p>
                        <p className="dictionary-empty-subtitle">Add words that are frequently misheard</p>
                    </div>
                ) : (
                    <div className="dictionary-entries">
                        {dictionary.map((entry) => (
                            <div
                                key={entry.id}
                                onClick={() => handleItemClick(entry.id)}
                                onDoubleClick={() => {
                                    if (!isSelectMode) {
                                        setSelectedItems(new Set([entry.id]));
                                        setEditingId(entry.id);
                                        setOriginal(entry.original);
                                        setReplacement(entry.replacement);
                                        setIsEditing(true);
                                    }
                                }}
                                className={`dictionary-entry ${selectedItems.has(entry.id) ? 'selected' : ''}`}
                            >
                                {isSelectMode && (
                                    <div style={{ flexShrink: 0 }}>
                                        {selectedItems.has(entry.id)
                                            ? <CheckSquare size={14} style={{ color: 'var(--accent)' }} />
                                            : <Square size={14} style={{ color: 'var(--text-tertiary)' }} />
                                        }
                                    </div>
                                )}
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div className="dictionary-entry-mapping">
                                        <span className="dictionary-entry-original">{entry.original}</span>
                                        <ArrowRight size={10} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                                        <span className="dictionary-entry-replacement">{entry.replacement}</span>
                                    </div>
                                    {entry.variants && entry.variants.length > 0 && (
                                        <p className="dictionary-entry-variants">
                                            Also matches: {entry.variants.slice(0, 2).join(', ')}
                                        </p>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Footer with Export/Import */}
            <div className="dictionary-footer">
                <span className="dictionary-count">
                    {dictionary.length} correction{dictionary.length !== 1 ? 's' : ''}
                </span>
                <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => fileInputRef.current?.click()} className="dict-btn dict-btn-ghost">
                        <Upload size={11} />
                        Import
                    </button>
                    <button
                        onClick={handleExport}
                        disabled={dictionary.length === 0}
                        className="dict-btn dict-btn-ghost"
                    >
                        <Download size={11} />
                        Export
                    </button>
                </div>
            </div>
        </div>
    );
};

// Export helper for external "Correct This" trigger
export function createDictionaryEntry(original: string, replacement: string): DictionaryEntry {
    return {
        id: crypto.randomUUID(),
        original,
        replacement,
        variants: generateVariants(original),
        createdAt: Date.now(),
    };
}
