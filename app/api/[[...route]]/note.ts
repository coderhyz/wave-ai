import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import z from "zod"
import { getAuthUser } from "@/lib/hono/hono-middware"
import prisma from "@/lib/prisma"
// 传来的参数校验
const noteSchema = z.object({
  title: z.string().min(1),
  content: z.string(),
})

const noteIdSchema = z.object({
  id: z.string().min(1),
})

const noteUpdateSchema = noteSchema.partial()

export const noteRoute = new Hono()
  .post("/create", zValidator("json", noteSchema), getAuthUser, async (c) => {
    // 创建笔记接口
    try {
      const user = c.get("user")
      const { title, content } = c.req.valid("json")
      // 创建笔记
      const note = await prisma.note.create({
        data: {
          title,
          content,
          userId: user.id,
        },
      })
      return c.json({ success: true, note })
    } catch (error) {
      console.log(error)
      throw new HTTPException(500, { message: "Failed to create note" })
    }
  })
  .patch(
    "/update/:id",
    zValidator("json", noteUpdateSchema),
    zValidator("param", noteIdSchema),
    getAuthUser,
    async (c) => {
      // 更新笔记接口
      try {
        const user = c.get("user")
        const { id } = c.req.valid("param")
        const body = c.req.valid("json")
        const existingNote = await prisma.note.findUnique({
          where: { id, userId: user.id },
        })

        if (!existingNote) {
          throw new HTTPException(404, { message: "Note not found" })
        }

        const updatedNote = await prisma.note.update({
          where: { id, userId: user.id },
          data: {
            title: body.title,
            content: body.content,
          },
        })

        return c.json({ success: true, note: updatedNote })
      } catch (error) {
        console.log(error)
        if (error instanceof HTTPException) {
          throw error
        }
        throw new HTTPException(500, { message: "Failed to update note" })
      }
    }
  )
  .delete(
    "/delete/:id",
    zValidator("param", noteIdSchema),
    getAuthUser,
    async (c) => {
      // 删除笔记接口
      try {
        const user = c.get("user")
        const { id } = c.req.valid("param")
        const existingNote = await prisma.note.findUnique({
          where: { id, userId: user.id },
        })

        if (!existingNote) {
          throw new HTTPException(404, { message: "Note not found" })
        }

        await prisma.note.delete({
          where: { id, userId: user.id },
        })

        return c.json({ success: true, message: "Note deleted successfully" })
      } catch (error) {
        console.log(error)
        if (error instanceof HTTPException) {
          throw error
        }
        throw new HTTPException(500, { message: "Failed to delete note" })
      }
    }
  )
  .get("/all", getAuthUser, async (c) => {
    // 获取所有笔记接口，支持分页
    try {
      const user = c.get("user")
      const query = c.req.query()
      // 页数
      const page = query.page ? parseInt(query.page, 10) : 1
      // 每页条数
      const limit = query.limit ? parseInt(query.limit, 10) : 20
      const [allNotes, totalCount] = await Promise.all([
        prisma.note.findMany({
          where: { userId: user.id },
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.note.count({
          where: { userId: user.id },
        }),
      ])

      return c.json({
        success: true,
        notes: allNotes,
        pagination: {
          total: totalCount,
          page: page,
          limit: limit,
          total_pages: Math.ceil(totalCount / limit),
          skip: (page - 1) * limit,
        },
      })
    } catch (error) {
      console.log(error)
      throw new HTTPException(500, { message: "Failed to retrieve notes" })
    }
  })
  .get("/:id", zValidator("param", noteIdSchema), getAuthUser, async (c) => {
    // 获取单个笔记接口
    try {
      const user = c.get("user")
      const { id } = c.req.valid("param")
      const note = await prisma.note.findFirst({
        where: { id, userId: user.id },
      })

      if (!note) {
        throw new HTTPException(404, { message: "Note not found" })
      }

      return c.json({
        success: true,
        data: note,
      })
    } catch (error) {
      if (error instanceof HTTPException) {
        throw error
      }
      throw new HTTPException(500, { message: "Internal server error" })
    }
  })
