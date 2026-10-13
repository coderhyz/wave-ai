import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import { getAuthUser } from "@/lib/hono/hono-middware"
import { runKnowledgeApi } from "@/lib/knowledge/errors"
import { searchKnowledgeSchema } from "@/lib/knowledge/schemas"
import { searchKnowledge } from "@/lib/knowledge/retrieval/search"

export const knowledgeSearchRoute = new Hono().post(
  "/",
  getAuthUser,
  zValidator("json", searchKnowledgeSchema),
  async (c) =>
    runKnowledgeApi(async () => {
      const result = await searchKnowledge(
        c.get("user").id,
        c.req.valid("json"),
        c.req.raw.signal
      )
      return c.json({ success: true, ...result })
    })
)
