import { createStep, StepResponse } from '@medusajs/workflows-sdk'
import { MEILISEARCH_MODULE, MeiliSearchService } from '../../modules/meilisearch'
import { SearchUtils } from '@medusajs/utils'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Modules } = require('@medusajs/framework/utils')

export type StepInput = {
  filters?: Record<string, unknown>
  limit?: number
  offset?: number
}

export const syncProductsStep = createStep(
  'sync-products',
  async ({ filters, limit, offset }: StepInput, { container }) => {
    const queryService = container.resolve('query')
    const meilisearchService: MeiliSearchService = container.resolve(MEILISEARCH_MODULE)
    const salesChannelService = container.resolve(Modules.SALES_CHANNEL)

    // Default sales channel ID (same logic as custom script)
    let salesChannelId: string | undefined
    try {
      const defaultChannel = await salesChannelService.listSalesChannels({ name: 'Default Sales Channel' })
      if (defaultChannel?.[0]) salesChannelId = defaultChannel[0].id
    } catch {}

    // Explicit full field list so variant data is included for custom transformer
    const productFields = [
      '*',
      'images.*',
      'variants.*',
      'variants.prices.*',
      'variants.options.*',
      'variants.options.option.*',
      'variants.options.metadata',
      'categories.*',
      'tags.*',
      'collection.*',
    ]
    const productIndexes = await meilisearchService.getIndexesByType(SearchUtils.indexTypes.PRODUCTS)

    const { data: products } = await queryService.graph({
      entity: 'product',
      fields: productFields,
      pagination: {
        take: limit,
        skip: offset,
      },
      filters: {
        status: 'published',
        ...filters,
      },
    })

    // Compute variant availability like custom indexing script
    if (salesChannelId) {
      const { getVariantAvailability } = require('@medusajs/framework/utils') as any
      const variantIds = products.flatMap((p:any)=> (p.variants||[]).map((v:any)=> v.id))
      const availability = await getVariantAvailability(queryService, { variant_ids: variantIds, sales_channel_id: salesChannelId })

      // attach inventory_quantity to variants
      for (const p of products) {
        for (const v of p.variants || []) {
          const inv = availability[v.id]?.availability || 0
          v.inventory_quantity = inv
        }
      }
    }

    const existingProductIds = new Set(
      (
        await Promise.all(
          productIndexes.map((index) =>
            meilisearchService.search(index, '', {
              filter: `id IN [${products.map((p) => p.id).join(',')}]`,
              attributesToRetrieve: ['id'],
            }),
          ),
        )
      )
        .flatMap((result) => result.hits)
        .map((hit) => hit.id),
    )

    const productsToDelete = Array.from(existingProductIds).filter((id) => !products.some((p) => p.id === id))

    await Promise.all(productIndexes.map((index) => meilisearchService.addDocuments(index, products)))
    await Promise.all(productIndexes.map((index) => meilisearchService.deleteDocuments(index, productsToDelete)))

    return new StepResponse({
      products,
    })
  },
)
