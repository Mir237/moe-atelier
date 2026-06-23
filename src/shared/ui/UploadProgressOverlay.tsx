import React from 'react';
import { Progress, Spin } from 'antd';
import { LoadingOutlined } from '@ant-design/icons';

interface UploadProgressOverlayProps {
  percent?: number | null;
}

const UploadProgressOverlay = ({ percent }: UploadProgressOverlayProps) => {
  const hasPercent = typeof percent === 'number' && Number.isFinite(percent);

  return (
    <div className="upload-progress-overlay" aria-label="正在上传图片">
      {hasPercent ? (
        <Progress
          type="circle"
          percent={Math.max(0, Math.min(100, Math.round(percent)))}
          size={42}
          strokeColor="#FF9EB5"
          trailColor="rgba(255, 255, 255, 0.7)"
        />
      ) : (
        <Spin
          indicator={
            <LoadingOutlined style={{ fontSize: 30, color: '#FF9EB5' }} spin />
          }
        />
      )}
    </div>
  );
};

export default UploadProgressOverlay;
