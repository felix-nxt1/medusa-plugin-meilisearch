import { createStep, StepResponse } from '@medusajs/workflows-sdk'
import { SearchUtils } from '@medusajs/utils'
import { MEILISEARCH_MODULE, MeiliSearchService } from '../../modules/meilisearch'

export type StepInput = {
  id: string
}

export const upsertProductStep = createStep('upsert-products', async ({ id }: StepInput, { container }) => {
  const queryService: any = container.resolve('query')
  const meilisearchService: MeiliSearchService = container.resolve(MEILISEARCH_MODULE)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Modules } = require('@medusajs/framework/utils')

  // Use explicit fields like the full sync to ensure variants and nested data are loaded
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
    filters: { id },
  })

  // Compute variant availability like the full sync step (optional but useful)
  try {
    const salesChannelService: any = container.resolve(Modules.SALES_CHANNEL)
    let salesChannelId: string | undefined
    try {
      const defaultChannel = await salesChannelService.listSalesChannels({ name: 'Default Sales Channel' })
      if (defaultChannel?.[0]) salesChannelId = defaultChannel[0].id
    } catch {}

    if (salesChannelId && products?.length) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getVariantAvailability } = require('@medusajs/framework/utils') as any
      const variantIds = products.flatMap((p:any)=> (p.variants||[]).map((v:any)=> v.id))
      if (variantIds.length) {
        const availability = await getVariantAvailability(queryService, { variant_ids: variantIds, sales_channel_id: salesChannelId })
        for (const p of products) {
          for (const v of p.variants || []) {
            const inv = availability[v.id]?.availability || 0
            v.inventory_quantity = inv
          }
        }
      }
    }
  } catch {}

  await Promise.all(
    (products || []).map(async (product) => {
      if (!product.status || product.status === 'published') {
        await Promise.all(productIndexes.map((indexKey) => meilisearchService.addDocuments(indexKey, [product])))
      } else {
        await Promise.all(productIndexes.map((indexKey) => meilisearchService.deleteDocument(indexKey, product.id)))
      }
    }),
  )

  return new StepResponse({
    products,
  })
})
