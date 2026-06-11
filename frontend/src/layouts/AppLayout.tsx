import { AppShell, type NavItem } from "@genai/ui";
import {
  CheckSquare,
  ClipboardList,
  FileJson,
  FileText,
  FolderOpen,
  LayoutDashboard,
  Sparkles,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";

const navItems: NavItem[] = [
  { key: "home", label: "대시보드", icon: LayoutDashboard, href: "/" },
  { key: "documents", label: "문서 보관함", icon: FolderOpen, href: "/#documents" },
  { key: "raw", label: "원문 추출", icon: FileText, href: "/#raw" },
  { key: "key-info", label: "핵심 정보", icon: Sparkles, href: "/#key-info" },
  { key: "classifier", label: "문서 분류", icon: ClipboardList, href: "/#classifier" },
  { key: "required-checker", label: "필수 항목", icon: CheckSquare, href: "/#required-checker" },
  { key: "workflow", label: "워크플로우", icon: FileJson, href: "/#workflow" },
];

function activeKeyFromHash(hash: string) {
  const key = hash.replace("#", "");
  if (key.startsWith("workflow-result:")) return "workflow";
  return navItems.some((item) => item.key === key) ? key : "home";
}

export default function AppLayout() {
  const [activeKey, setActiveKey] = useState(() => activeKeyFromHash(window.location.hash));

  useEffect(() => {
    const updateActiveKey = () => setActiveKey(activeKeyFromHash(window.location.hash));
    window.addEventListener("hashchange", updateActiveKey);
    window.addEventListener("popstate", updateActiveKey);
    return () => {
      window.removeEventListener("hashchange", updateActiveKey);
      window.removeEventListener("popstate", updateActiveKey);
    };
  }, []);

  return (
    <AppShell
      className="common-app-shell"
      logo={<span className="common-layout-logo">Document AI</span>}
      nav={navItems}
      activeKey={activeKey}
      renderLink={({ item, className, children }) => (
        <a href={item.href ?? "/"} className={className}>
          {children}
        </a>
      )}
      header={{
        title: "Document Automation Workspace",
        centerLogo: <span className="common-layout-title">문서 자동화 워크스페이스</span>,
      }}
    >
      <Outlet />
    </AppShell>
  );
}
