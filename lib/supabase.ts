import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL!;
const key = process.env.SUPABASE_PUBLISHABLE_KEY!;
// 创建一个不带身份验证的 Supabase 客户端实例
export function createUserSupabase(token: string) {
    return createClient(url, key, {
        global: {
            headers: {
                Authorization: `Bearer ${token}`,
            },
        },
        auth: {
            persistSession: false,
            autoRefreshToken: false,
        },
    });
}