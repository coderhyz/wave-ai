import {
  useMutation,
  useQueryClient,
  useQuery,
  useSuspenseQuery,
} from "@tanstack/react-query"
import type { InferRequestType, InferResponseType } from "hono/client"
import { toast } from "sonner"
import { api } from "@/lib/hono/hono-rpc"

type RequestCreateNoteType = InferRequestType<typeof api.note.create.$post>
type ResponseCreateNoteType = InferResponseType<typeof api.note.create.$post>
type RequestUpdateNoteType = InferRequestType<
  (typeof api.note.update)[":id"]["$patch"]
>
type ResponseUpdateNoteType = InferResponseType<
  (typeof api.note.update)[":id"]["$patch"]
>

// 创建笔记
export const useCreateNote = () => {
  const queryClient = useQueryClient()
  /**
   * ResponseCreateNoteType:成功返回的数据类型,
   * Error:                 失败错误类型,
   * RequestCreateNoteType["json"]: mutationFn接收的参数类型
   */
  return useMutation<
    ResponseCreateNoteType,
    Error,
    RequestCreateNoteType["json"]
  >({
    mutationFn: async (json) => {
      const response = await api.note.create.$post({ json })
      if (!response.ok) {
        throw new Error("创建笔记失败")
      }
      return await response.json()
    },
    onSuccess: () => {
      // 创建成功后，重新获取笔记列表
      queryClient.invalidateQueries({ queryKey: ["notes"], refetchType: "all" })
    },
    onError: (error) => {
      toast.error(error.message ?? "创建笔记失败")
    },
  })
}

/// 所有笔记
export const useNotes = (page: number = 1, limit: number = 20) => {
  return useQuery({
    queryKey: ["notes", page, limit],
    queryFn: async () => {
      const res = await api.note.all.$get({
        query: { page, limit },
      })
      if (!res.ok) {
        throw new Error("Failed to fetch note")
      }
      const data = await res.json()
      return data
    },
  })
}
// 使用 Suspense 获取笔记列表
export const useSuspenseNotes = (page: number = 1, limit: number = 20) => {
  return useSuspenseQuery({
    queryKey: ["notes", page, limit],
    queryFn: async () => {
      const res = await api.note.all.$get({
        query: { page, limit },
      })
      if (!res.ok) {
        throw new Error("Failed to fetch note")
      }
      return await res.json()
    },
  })
}
// 单个笔记
export const useNote = (id: string) => {
  return useQuery({
    queryKey: ["note", id],
    queryFn: async () => {
      const res = await api.note[":id"].$get({
        param: { id },
      })
      if (!res.ok) {
        throw new Error("Failed to fetch note")
      }
      const data = await res.json()
      return data
    },
    enabled: Boolean(id),
  })
}

// 重建更新笔记
export const useUpdateNote = () => {
  const queryClient = useQueryClient()
  return useMutation<
    ResponseUpdateNoteType,
    Error,
    { id: string; json: RequestUpdateNoteType["json"] }
  >({
    mutationFn: async ({ id, json }) => {
      // 更新笔记
      const response = await api.note.update[":id"].$patch({
        param: { id },
        json,
      })
      return await response.json()
    },
    onSuccess: () => {
      toast.success("笔记保存成功")
      queryClient.invalidateQueries({
        queryKey: ["notes"],
        refetchType: "all",
      })
    },
    onError: (error) => {
      toast.error(error?.message ?? "保存笔记失败")
    },
  })
}
