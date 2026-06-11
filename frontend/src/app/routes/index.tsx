import { createBrowserRouter } from "react-router-dom";

import AppLayout from "@/layouts/AppLayout";
import DocumentAutomationPage from "@/pages/DocumentAutomationPage";

export const routes = createBrowserRouter([
  {
    path: "/",
    element: <AppLayout />,
    children: [{ index: true, element: <DocumentAutomationPage /> }],
  },
]);
