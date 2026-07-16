import { apiClient } from './apiClient';

export const aiApi = {
    /**
     * Generate SQL from natural language question
     * @param {string} question - Natural language question
     * @param {object} metadata - Context-specific metadata (column info, sources, etc.)
     * @param {string} promptType - Type of prompt (query_page, field_transform, sql_transform, partition)
     * @param {string} context - Optional additional context
     * @returns {Promise<Object>} { sql: string, schema_context: string }
     */
    async generateSQL(question, metadata = {}, promptType = 'query_page', context = null, engine = 'trino') {
        return apiClient.post('/api/ai/generate-sql', {
            question,
            promptType,
            metadata,
            context,
            engine,
        });
    },
};
