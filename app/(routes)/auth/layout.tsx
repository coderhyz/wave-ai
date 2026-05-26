import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";

export default async function AuthLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const session = await auth.api.getSession({
        headers: await headers(), // you need to pass the headers object.
    });

    if (session) {
        return redirect("/home");
    }
    return <div className="h-screen flex items-center justify-center">{children}</div>;
}