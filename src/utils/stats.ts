export const calculateSuccessRate = (totalRequests: number, successCount: number) =>
  totalRequests > 0 ? Math.round((successCount / totalRequests) * 100) : 0;

export const formatDuration = (ms: number) => {
  if (!ms) return '0s';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const remainingSeconds = totalSeconds % 3600;
  const mins = Math.floor(remainingSeconds / 60);
  const secs = remainingSeconds % 60;
  
  if (hours > 0) {
    return `${hours}h${mins}m${secs}s`;
  }
  return `${mins}m${secs}s`;
};
