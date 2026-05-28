
function MainContent({ children }: { children: React.ReactNode }) {
    return (
        <div className="min-h-0 w-full flex-1">
            {children}
        </div>
    );
}

export default MainContent;
