import { ApiRequestTimeoutError, apiClient } from './apiClient';

/**
 * Schema Transform API
 * Handles preview and testing of SQL transformations
 */
export const schemaTransformApi = {
    /**
     * Test SQL transform with preview
     * POST /api/sql/test
     *
     * @param {Array} sources - Array of source configurations with dataset IDs and columns
     * @param {string} sql - SQL query to test
     * @returns {Promise} Test result with before/after samples
     */
    async testSqlTransform(sources, sql, timeoutMs = 20000) {
        try {
            return await apiClient.post('/api/sql/test', {
                sources,
                sql,
                limit: 10,
            }, { timeoutMs });
        } catch (err) {
            if (err instanceof ApiRequestTimeoutError) {
                throw new Error('Preview timed out. Please try again.');
            }
            throw err;
        }
    }
};
