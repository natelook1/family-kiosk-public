import { Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import NewPatient from './pages/NewPatient'
import PatientDetail from './pages/PatientDetail'
import ShareApp from './pages/ShareApp'

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/patients/new" element={<NewPatient />} />
        <Route path="/patients/:patientId" element={<PatientDetail />} />
        <Route path="/share-app" element={<ShareApp />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  )
}
