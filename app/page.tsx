import { MasterPanel } from "@/components/master-panel";
import { adminConfigured,isAdmin } from "@/lib/admin";
import { LoginView } from "@/components/login-view";
export const dynamic="force-dynamic";

export default async function Home() {
  if(!await isAdmin()) return <LoginView configured={adminConfigured()}/>;
  return <MasterPanel />;
}
