const pLimit = require('p-limit');
const parser = require('./parser');
const log = require('./logger');

/**
 * Бизнес-логика: одна декларация, пакеты, связка с HTTP-клиентом.
 */

function createDeclarationService(apiClient, cfg) {
  const limit = pLimit(cfg.concurrency);

  /**
   * Полные сведения по одной декларации (агрегация API + нормализация).
   * @param {string|number} declarationId
   * @param {{ listItem?: object }} [options] — строка списка для «Группа продукции ЕАЭС» (group)
   */
  async function getDeclarationData(declarationId, options = {}) {
    const id = String(declarationId).trim();
    if (!id) {
      log.warn('declaration', 'getDeclarationData: пустой id');
      return { ...parser.EMPTY_DECL };
    }
    try {
      await apiClient.ensureAuth();
      const detail = await apiClient.getDeclarationById(id);
      return parser.mapToGetDeclarationData(detail, options.listItem || null);
    } catch (e) {
      log.error('declaration', `getDeclarationData(${id}): ${e.message}`);
      if (options.strict) throw e;
      if (options.listItem) return parser.mapToGetDeclarationData({}, options.listItem);
      return { ...parser.EMPTY_DECL };
    }
  }

  /**
   * Пакетная загрузка с ограничением параллелизма.
   * @param {(string|number)[]} ids
   * @param {{ listItemsById?: Record<string, object> }} [options]
   * @returns {Promise<Map<string, object>>}
   */
  async function getDeclarationsData(ids, options = {}) {
    const map = options.listItemsById || {};
    const unique = [...new Set(ids.map(String))];
    const results = new Map();
    await Promise.all(
      unique.map((id) =>
        limit(async () => {
          const data = await getDeclarationData(id, { listItem: map[id] || null });
          results.set(id, data);
        })
      )
    );
    return results;
  }

  return {
    getDeclarationData,
    getDeclarationsData,
  };
}

module.exports = { createDeclarationService };
