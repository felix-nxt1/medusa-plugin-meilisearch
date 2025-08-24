import { SearchTypes } from '@medusajs/types'
import { SearchUtils } from '@medusajs/utils'
import { MeiliSearch } from 'meilisearch'
import { meilisearchErrorCodes, MeilisearchPluginOptions } from '../types'
import { transformProduct, TransformOptions } from '../utils/transformer'

export class MeiliSearchService extends SearchUtils.AbstractSearchService {
  static identifier = 'index-meilisearch'

  isDefault = false

  protected readonly config_: MeilisearchPluginOptions
  protected readonly client_: MeiliSearch
  private readonly container_: any

  constructor(container: any, options: MeilisearchPluginOptions) {
    super(container, options)

    this.container_ = container
    this.config_ = options

    if (!options.config?.apiKey) {
      throw Error(
        'Meilisearch API key is missing in plugin config. See https://github.com/rokmohar/medusa-plugin-meilisearch',
      )
    }

    if (!options.config?.host) {
      throw Error(
        'Meilisearch host is missing in plugin config. See https://github.com/rokmohar/medusa-plugin-meilisearch',
      )
    }

    this.client_ = new MeiliSearch(options.config)
  }

  protected getLanguageIndexKey(baseKey: string, language?: string): string {
    const { i18n } = this.config_

    if (!i18n || i18n.strategy !== 'separate-index' || !language) {
      return baseKey
    }

    return `${baseKey}_${language}`
  }

  async getFieldsForType(type: string) {
    const fields = new Set<string>()

    Object.values(this.config_.settings || {})
      .filter((config) => config.type === type && config.enabled !== false)
      .forEach((config) => {
        if (Array.isArray(config.fields)) {
          config.fields.forEach((field) => fields.add(field))
        }
      })

    if (!fields.size) {
      fields.add('*')
    }

    const { i18n } = this.config_

    if (i18n?.strategy === 'field-suffix' && i18n.translatableFields) {
      const { languages, translatableFields } = i18n
      for (const field of translatableFields) {
        for (const lang of languages) {
          fields.add(`${field}_${lang}`)
        }
      }
    }

    return Array.from(fields)
  }

  async getIndexesByType(type: string) {
    const { i18n } = this.config_
    const baseIndexes = Object.entries(this.config_.settings || {})
      .filter(([, config]) => config.type === type && config.enabled !== false)
      .map(([key]) => key)

    if (i18n?.strategy === 'separate-index') {
      const { languages } = i18n
      return baseIndexes.flatMap((baseIndex) => languages.map((lang) => this.getLanguageIndexKey(baseIndex, lang)))
    }

    return baseIndexes
  }

  async createIndex(indexKey: string, options: Record<string, unknown> = { primaryKey: 'id' }) {
    return this.client_.createIndex(indexKey, options)
  }

  getIndex(indexKey: string) {
    return this.client_.index(indexKey)
  }

  async addDocuments(indexKey: string, documents: any[], language?: string) {
    const { i18n } = this.config_
    const i18nOptions = {
      i18n,
      language,
    }

    if (i18n?.strategy === 'separate-index') {
      if (!documents?.length) return
      const langIndexKey = this.getLanguageIndexKey(indexKey, language || i18n.defaultLanguage)
      const transformedDocuments = await this.getTransformedDocuments(indexKey, documents, i18nOptions)
      if (!transformedDocuments.length) return
      const task = await this.client_.index(langIndexKey).addDocuments(transformedDocuments, { primaryKey: 'id' })
      await this.waitTask(task)
      return task
    } else {
      const transformedDocuments = await this.getTransformedDocuments(indexKey, documents, i18nOptions)
      if (!transformedDocuments.length) return
      const task = await this.client_.index(indexKey).addDocuments(transformedDocuments, { primaryKey: 'id' })
      await this.waitTask(task)
      return task
    }
  }

  async replaceDocuments(indexKey: string, documents: any[], language?: string) {
    return this.addDocuments(indexKey, documents, language)
  }

  async deleteDocument(indexKey: string, documentId: string, language?: string) {
    const actualIndexKey = this.getLanguageIndexKey(indexKey, language)
    return this.client_.index(actualIndexKey).deleteDocument(documentId)
  }

  async deleteDocuments(indexKey: string, documentIds: string[], language?: string) {
    const actualIndexKey = this.getLanguageIndexKey(indexKey, language)
    return this.client_.index(actualIndexKey).deleteDocuments(documentIds)
  }

  async deleteAllDocuments(indexKey: string, language?: string) {
    const actualIndexKey = this.getLanguageIndexKey(indexKey, language)
    return this.client_.index(actualIndexKey).deleteAllDocuments()
  }

  async search(indexKey: string, query: string, options: Record<string, any> & { language?: string }) {
    const { language, paginationOptions, filter, additionalOptions } = options
    const actualIndexKey = this.getLanguageIndexKey(indexKey, language)
    return this.client_.index(actualIndexKey).search(query, { filter, ...paginationOptions, ...additionalOptions })
  }

  async updateSettings(indexKey: string, settings: Pick<SearchTypes.IndexSettings, 'indexSettings' | 'primaryKey'>) {
    const indexConfig = this.config_.settings?.[indexKey]
    if (indexConfig?.enabled === false) {
      return
    }

    const { i18n } = this.config_

    if (i18n?.strategy === 'separate-index') {
      const { languages } = i18n
      return Promise.all(
        languages.map(async (lang) => {
          const langIndexKey = this.getLanguageIndexKey(indexKey, lang)
          await this.upsertIndex(langIndexKey, settings)
          return this.client_.index(langIndexKey).updateSettings(settings.indexSettings ?? {})
        }),
      )
    } else {
      await this.upsertIndex(indexKey, settings)
      return this.client_.index(indexKey).updateSettings(settings.indexSettings ?? {})
    }
  }

  async upsertIndex(indexKey: string, settings: Pick<SearchTypes.IndexSettings, 'primaryKey'>) {
    const indexConfig = this.config_.settings?.[indexKey]
    if (indexConfig?.enabled === false) {
      return
    }
    try {
      await this.client_.getIndex(indexKey)
    } catch (error) {
      if (error.code === meilisearchErrorCodes.INDEX_NOT_FOUND) {
        await this.createIndex(indexKey, {
          primaryKey: settings.primaryKey ?? 'id',
        })
      }
    }
  }

  private async getTransformedDocuments(indexKey: string, documents: any[], options?: TransformOptions) {
    if (!documents?.length) {
      return []
    }

    const indexConfig = (this.config_.settings || {})[indexKey]

    switch (indexConfig?.type) {
      case SearchUtils.indexTypes.PRODUCTS:
        const aggregated: any[] = []
        for (const doc of documents) {
          const resMaybe = indexConfig.transformer?.(doc, transformProduct, { ...options, container: this.container_ }) ?? transformProduct(doc, { ...options, container: this.container_ })
          const res = await Promise.resolve(resMaybe)
          if (Array.isArray(res)) {
            aggregated.push(...res)
          } else {
            aggregated.push(res)
          }
        }
        // Sanitize: ensure all values are JSON-serialisable (remove undefined/BigInt etc.)
        const cleaned = aggregated.map((doc) => JSON.parse(JSON.stringify(doc))).filter(d => d && d.id)

        // Use Medusa logger instead of console
        try {
          const logger = this.container_.resolve('logger')
          logger.info(`Meilisearch: prepared ${aggregated.length} docs, cleaned ${cleaned.length} for index "${indexKey}"`)
          if (cleaned.length === 0 && aggregated.length > 0) {
            logger.warn(`Meilisearch: first aggregated doc missing id for index "${indexKey}"`)
          }
        } catch {}
        return cleaned

      default:
        return documents
    }
  }

  // Helper to wait for task completion across SDK versions
  private async waitTask(task: any) {
    const uid = task?.taskUid ?? task?.uid ?? task?.uidTask
    if (uid == null) return
    // v1 has client.getTask or client.tasks.getTask
    const poll = async () => {
      let t: any
      if (typeof (this.client_ as any).getTask === 'function') {
        t = await (this.client_ as any).getTask(uid)
      } else if ((this.client_ as any).tasks?.getTask) {
        t = await (this.client_ as any).tasks.getTask(uid)
      }
      return t
    }
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const current = await poll()
      if (!current) return
      if (current.status === 'succeeded') return
      if (current.status === 'failed') throw new Error(`Meilisearch task ${uid} failed: ${current.error?.message}`)
      await new Promise(res => setTimeout(res, 50))
    }
  }
}
