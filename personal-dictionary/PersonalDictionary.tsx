import React, { useState, useEffect, useRef } from 'react';
import { X, Plus, Trash2, Book, ArrowRight, Pencil, CheckSquare, Square, Download, Upload } from 'lucide-react';
import { DictionaryEntry, generateVariants } from '../types';

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

    // Exit select mode when modal closes
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
            } catch (err) {
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
        <div className="absolute inset-0 z-50 bg-slate-900/95 backdrop-blur-xl flex flex-col animate-in fade-in duration-200 text-left">

            {/* Hidden file input for import */}
            <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                onChange={handleImport}
                className="hidden"
            />

            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-white/5 shrink-0">
                <div className="flex items-center gap-3">
                    <Book className="w-5 h-5 text-blue-400" />
                    <div>
                        <h2 className="text-base font-semibold text-white">Personal Dictionary</h2>
                        <p className="text-xs text-slate-400">Correct misheard words automatically</p>
                    </div>
                </div>
                <button
                    onClick={onClose}
                    className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 transition-colors"
                >
                    <X className="w-4 h-4 text-slate-400" />
                </button>
            </div>

            {/* Actions Row 1: Add, Edit, Delete */}
            <div className="flex gap-2 p-3 border-b border-white/5">
                <button
                    onClick={() => { resetForm(); setIsAdding(true); setIsSelectMode(false); }}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-500/20 hover:bg-blue-500/30 rounded-lg transition-colors"
                >
                    <Plus className="w-3 h-3" />
                    Add
                </button>

                {dictionary.length > 0 && (
                    <button
                        onClick={toggleSelectMode}
                        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${isSelectMode
                            ? 'text-blue-400 bg-blue-500/20'
                            : 'text-slate-300 bg-white/10 hover:bg-white/15'
                            }`}
                    >
                        <CheckSquare className="w-3 h-3" />
                        {isSelectMode ? 'Done' : 'Select'}
                    </button>
                )}

                {isSelectMode && dictionary.length > 0 && (
                    <button
                        onClick={handleSelectAll}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-300 bg-white/10 hover:bg-white/15 rounded-lg transition-colors"
                    >
                        {allSelected ? <CheckSquare className="w-3 h-3" /> : <Square className="w-3 h-3" />}
                        {allSelected ? 'Deselect All' : 'Select All'}
                    </button>
                )}

                {!isSelectMode && selectedItems.size === 1 && (
                    <button
                        onClick={handleEdit}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-300 bg-white/10 hover:bg-white/15 rounded-lg transition-colors"
                    >
                        <Pencil className="w-3 h-3" />
                        Edit
                    </button>
                )}

                {selectedItems.size > 0 && (
                    <button
                        onClick={handleDelete}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-400 bg-red-500/10 hover:bg-red-500/20 rounded-lg transition-colors"
                    >
                        <Trash2 className="w-3 h-3" />
                        Delete ({selectedItems.size})
                    </button>
                )}
            </div>

            {/* Add/Edit Correction Form */}
            {showForm && (
                <div className="p-4 border-b border-white/5 bg-white/5">
                    <div className="flex items-center gap-1 mb-3">
                        <span className="text-xs font-medium text-slate-300">
                            {isEditing ? 'Edit Correction' : 'New Correction'}
                        </span>
                    </div>
                    <div className="flex items-center gap-3 mb-3">
                        <div className="flex-1">
                            <label className="text-xs text-slate-400 mb-1 block">What was written:</label>
                            <input
                                ref={originalInputRef}
                                type="text"
                                value={original}
                                onChange={(e) => setOriginal(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Escape') resetForm();
                                }}
                                className="w-full px-3 py-2 text-sm bg-slate-800 border border-white/10 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                                placeholder="e.g., D-Bridge"
                            />
                        </div>
                        <ArrowRight className="w-4 h-4 text-slate-500 mt-5" />
                        <div className="flex-1">
                            <label className="text-xs text-slate-400 mb-1 block">What you meant:</label>
                            <input
                                type="text"
                                value={replacement}
                                onChange={(e) => setReplacement(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') isEditing ? handleEditSave() : handleAdd();
                                    if (e.key === 'Escape') resetForm();
                                }}
                                className="w-full px-3 py-2 text-sm bg-slate-800 border border-white/10 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                                placeholder="e.g., deBridge"
                            />
                        </div>
                    </div>
                    <div className="flex justify-end gap-2">
                        <button
                            onClick={resetForm}
                            className="px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-white transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={isEditing ? handleEditSave : handleAdd}
                            disabled={!original.trim() || !replacement.trim()}
                            className="px-4 py-1.5 text-xs font-medium text-white bg-blue-500 hover:bg-blue-600 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {isEditing ? 'Save' : 'Add'}
                        </button>
                    </div>
                    {original.trim() && (
                        <p className="text-xs text-slate-500 mt-2">
                            Will also match: {generateVariants(original.trim()).slice(0, 3).join(', ')}
                            {generateVariants(original.trim()).length > 3 && '...'}
                        </p>
                    )}
                </div>
            )}

            {/* Dictionary List */}
            <div className="flex-1 overflow-y-auto p-2 custom-scrollbar">
                {dictionary.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-8 text-slate-500">
                        <Book className="w-6 h-6 mb-2 opacity-50" />
                        <p className="text-sm">No corrections added yet</p>
                        <p className="text-xs mt-1">Add words that are frequently misheard</p>
                    </div>
                ) : (
                    <div className="space-y-1">
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
                                className={`px-3 py-2 rounded-lg cursor-pointer transition-colors flex items-center gap-2 ${selectedItems.has(entry.id)
                                    ? 'bg-blue-500/20 border border-blue-500/30'
                                    : 'hover:bg-white/5 border border-transparent'
                                    }`}
                            >
                                {isSelectMode && (
                                    <div className="flex-shrink-0">
                                        {selectedItems.has(entry.id)
                                            ? <CheckSquare className="w-4 h-4 text-blue-400" />
                                            : <Square className="w-4 h-4 text-slate-500" />
                                        }
                                    </div>
                                )}
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className="text-sm text-slate-400 line-through truncate">{entry.original}</span>
                                        <ArrowRight className="w-3 h-3 text-slate-500 flex-shrink-0" />
                                        <span className="text-sm text-white font-medium truncate">{entry.replacement}</span>
                                    </div>
                                    {entry.variants && entry.variants.length > 0 && (
                                        <p className="text-xs text-slate-600 mt-0.5 truncate">
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
            <div className="p-3 border-t border-white/5 flex items-center justify-between shrink-0">
                <p className="text-xs text-slate-500">
                    {dictionary.length} correction{dictionary.length !== 1 ? 's' : ''}
                </p>
                <div className="flex gap-2">
                    <button
                        onClick={() => fileInputRef.current?.click()}
                        className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-400 hover:text-white bg-white/5 hover:bg-white/10 rounded-lg transition-colors"
                    >
                        <Upload className="w-3 h-3" />
                        Import
                    </button>
                    <button
                        onClick={handleExport}
                        disabled={dictionary.length === 0}
                        className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-400 hover:text-white bg-white/5 hover:bg-white/10 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <Download className="w-3 h-3" />
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
