import { useState } from 'react';
import { Sparkles, Send, X, Loader2 } from 'lucide-react';
import { aiApi } from '../../services/aiApi';

/**
 * InlineAIInput - Databricks-style inline AI assistance component
 * Expands below the trigger button to show an input field
 */
export default function InlineAIInput({
    promptType = 'general',
    metadata = {},
    placeholder = 'Ask AI to help...',
    engine = 'trino',  // Default engine changed to trino
    onApply,
    onCancel
}) {
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState(null);

    const handleSubmit = async (e) => {
        e?.preventDefault();
        if (!input.trim() || isLoading) return;

        setIsLoading(true);
        setError(null);

        try {
            // Call AI API with prompt type and metadata
            const response = await aiApi.generateSQL(
                input,
                metadata,
                promptType,
                null,  // context
                engine  // Pass engine to API
            );

            // Apply the AI suggestion (use the SQL from response)
            if (onApply && response.sql) {
                onApply(response.sql);
            }

            // Reset
            setInput('');
        } catch (err) {
            console.error('AI request failed:', err);
            setError(err.message || 'Failed to generate suggestion');
        } finally {
            setIsLoading(false);
        }
    };

    const handleCancel = () => {
        setInput('');
        setError(null);
        if (onCancel) {
            onCancel();
        }
    };

    // Only render the panel (button is controlled by parent)
    return (
        <div className="mb-2 rounded-xl border border-blue-200 bg-blue-50/70 p-3">
            <form onSubmit={handleSubmit} className="space-y-2">
                {/* Input field with icon and Generate button in same row */}
                <div className="flex items-center gap-2">
                    <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-blue-600">
                        <Sparkles size={14} className="text-white" />
                    </div>
                    <input
                        type="text"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        placeholder={placeholder}
                        disabled={isLoading}
                        autoFocus
                        className="flex-1 rounded-lg border border-blue-200 px-3 py-2 text-sm
                            focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500
                            disabled:bg-gray-50 disabled:text-gray-400
                            placeholder:text-gray-400"
                    />
                    <button
                        type="submit"
                        disabled={isLoading || !input.trim()}
                        className="flex items-center gap-1.5 bg-blue-600 px-3 py-2
                            hover:bg-blue-700 disabled:bg-gray-300
                            text-white rounded-lg text-sm font-medium transition-colors
                            disabled:cursor-not-allowed whitespace-nowrap"
                    >
                        {isLoading ? (
                            <>
                                <Loader2 size={14} className="animate-spin" />
                                <span>Generating...</span>
                            </>
                        ) : (
                            <>
                                <Send size={14} />
                                <span>Generate</span>
                            </>
                        )}
                    </button>
                </div>

                {/* Error Message */}
                {error && (
                    <div>
                        <p className="text-xs text-red-600">{error}</p>
                    </div>
                )}
            </form>
        </div>
    );
}
