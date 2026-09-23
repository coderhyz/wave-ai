import { Hono } from 'hono'
import { noteRoute } from './note'
import { HTTPException } from 'hono/http-exception'
import { handle } from 'hono/vercel'
import { getAuthUser } from '@/lib/hono/hono-middware'
import { chatRoute } from './chat'

export const runtime = "nodejs"

const app = new Hono()

app.onError((err, c) => {
    if (err instanceof HTTPException) {
        return err.getResponse();
    }
    return c.json({
        error: "internal error",
    });
});
//  Hono RPC 类型需要通过链式路由推导
const routes = app
    .basePath("/api")
    .route("/note", noteRoute)
    .route("/chat", chatRoute)
    .get("/", getAuthUser, (c) => {
        return c.json({
            message: "Hello from Wave AI",
        });
    });

export type AppType = typeof routes;

export const GET = handle(app)
export const POST = handle(app)
export const PUT = handle(app)
export const DELETE = handle(app)
export const PATCH = handle(app)
