
function MainContent({ children }: { children: React.ReactNode }) {
    return (
        <div className="w-full h-auto overflow-y-auto">
            {children}
        </div>
    );
}

export default MainContent;