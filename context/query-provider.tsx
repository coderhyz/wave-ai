import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * A React component that provides a QueryClient to its children.
 * @param param0 The props for the QueryProvider component.
 * @returns The QueryProvider component.
 */
function QueryProvider({ children }: Readonly<{ children: React.ReactNode }>) {
    const queryClient = new QueryClient();
    return (
        <QueryClientProvider client={queryClient}>
            {children}
        </QueryClientProvider>
    );
}

export default QueryProvider;