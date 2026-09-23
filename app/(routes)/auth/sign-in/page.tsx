import Logo from "@/components/logo"
import SignInForm from "../_common/signin-form"
const Page = () => {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-6 p-6 md:p-10">
      <div className="relative flex w-full max-w-sm flex-col gap-6">
        <div className="flex w-full items-center justify-center">
          <Logo />
        </div>
        <SignInForm />
      </div>
    </div>
  )
}

export default Page
