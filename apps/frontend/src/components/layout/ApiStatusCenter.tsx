import { useState, ReactNode } from 'react';
import { Button, Modal, Alert, Tag } from 'antd';
import api from '../../utils/api';
export default function ApiStatusCenter({ trigger }: { trigger?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<any[]>([]);
  const show = async () => {
    setOpen(true);
    try {
      setModels(await api.get<any, any[]>('/ai/models'));
    } catch {
      setModels([]);
    }
  };
  return (
    <>
      <span onClick={show}>{trigger || <Button>Gateways</Button>}</span>
      <Modal title="Gateway connections" open={open} onCancel={() => setOpen(false)} footer={null}>
        <Alert
          type="info"
          message="Gateway credentials are configured on the backend. Cloud processing requires each project's consent."
        />
        {models.map((model) => (
          <p key={model.type}>
            {model.type}: {model.name}{' '}
            <Tag color={model.enabled ? 'green' : 'orange'}>
              {model.enabled ? 'Configured' : 'Configuration required'}
            </Tag>
          </p>
        ))}
      </Modal>
    </>
  );
}
