import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Empty,
  Image,
  Input,
  Modal,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
  Upload,
  message,
} from 'antd';
import {
  CheckCircleFilled,
  CloseCircleFilled,
  CloudUploadOutlined,
  DeleteFilled,
  EditOutlined,
  InfoCircleFilled,
  LeftOutlined,
  LinkOutlined,
  PlusOutlined,
  RightOutlined,
  SendOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import type { UploadProps } from 'antd';
import type { TaskConfig } from '../types/app';
import {
  NANOBANANA_SUBMISSION_TARGET,
  buildNanobananaSubmissionDrafts,
  type NanobananaSubmissionPayload,
  type OneClickSubmissionDraft,
  submitNanobananaPrompt,
  uploadNanobananaImage,
} from '../utils/nanobananaSubmission';
import { loadCurrentPromptSourceTags } from '../utils/promptSourceTags';
import { getTaskDisplayName } from '../utils/taskName';
import './OneClickSubmissionModal.css';

const { Text, Title } = Typography;
const { TextArea } = Input;

type SubmissionStep = 'select' | 'edit';

interface OneClickSubmissionModalProps {
  open: boolean;
  tasks: TaskConfig[];
  backendMode: boolean;
  onClose: () => void;
}

const fileToDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('图片读取失败'));
      }
    };
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });

const buildPayload = (draft: OneClickSubmissionDraft): NanobananaSubmissionPayload => ({
  title: draft.title.trim(),
  content: draft.content.trim(),
  tags: draft.tags.map((tag) => tag.trim()).filter(Boolean),
  images: draft.images.map((image) => image.trim()).filter(Boolean),
  contributor: draft.contributor.trim() || '匿名',
  notes: draft.notes.trim(),
  action: 'create',
  targetId: null,
  variantIndex: null,
  originalTitle: null,
  submissionType: '全新投稿',
});

const getStatusTag = (draft: OneClickSubmissionDraft) => {
  if (draft.status === 'success') return <Tag color="success">已投稿</Tag>;
  if (draft.status === 'submitting') return <Tag color="processing">投递中</Tag>;
  if (draft.status === 'error') return <Tag color="error">失败</Tag>;
  return <Tag color="default">草稿</Tag>;
};

const getTaskPromptPreview = (task: TaskConfig) => {
  const firstLine = (task.prompt || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine || '尚未填写提示词';
};

const buildManualDraft = (): OneClickSubmissionDraft => ({
  id: `manual-${Date.now()}`,
  taskId: 'manual',
  taskName: '手动投稿',
  title: '',
  content: '',
  tags: [],
  images: [],
  contributor: '',
  notes: '',
  imageWarnings: [],
  status: 'draft',
});

const OneClickSubmissionModal: React.FC<OneClickSubmissionModalProps> = ({
  open,
  tasks,
  backendMode,
  onClose,
}) => {
  const [step, setStep] = useState<SubmissionStep>('select');
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<OneClickSubmissionDraft[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [urlInput, setUrlInput] = useState('');
  const [uploadingImage, setUploadingImage] = useState(false);
  const [preparingDrafts, setPreparingDrafts] = useState(false);
  const [submittingAll, setSubmittingAll] = useState(false);
  const [tagOptions, setTagOptions] = useState<{ label: string; value: string }[]>([]);
  const [tagsLoading, setTagsLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStep('select');
    setSelectedTaskIds([]);
    setDrafts([]);
    setActiveIndex(0);
    setUrlInput('');
    setUploadingImage(false);
    setPreparingDrafts(false);
    setSubmittingAll(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let ignore = false;
    setTagsLoading(true);
    void loadCurrentPromptSourceTags()
      .then((tags) => {
        if (ignore) return;
        setTagOptions(tags.map((tag) => ({ label: tag, value: tag })));
      })
      .catch((error) => {
        if (ignore) return;
        setTagOptions([]);
        console.error(error);
        message.warning('标签数据源读取失败，可继续自定义标签');
      })
      .finally(() => {
        if (!ignore) setTagsLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const availableTaskIds = new Set(tasks.map((task) => task.id));
    setSelectedTaskIds((current) => {
      const next = current.filter((taskId) => availableTaskIds.has(taskId));
      return next.length === current.length ? current : next;
    });
  }, [open, tasks]);

  const selectedTaskIdSet = useMemo(() => new Set(selectedTaskIds), [selectedTaskIds]);
  const selectedTasks = useMemo(
    () => tasks.filter((task) => selectedTaskIdSet.has(task.id)),
    [selectedTaskIdSet, tasks],
  );
  const activeDraft = drafts[activeIndex];
  const doneCount = useMemo(
    () => drafts.filter((draft) => draft.status === 'success').length,
    [drafts],
  );
  const allTasksSelected = tasks.length > 0 && selectedTaskIds.length === tasks.length;

  const toggleTask = (taskId: string, checked: boolean) => {
    setSelectedTaskIds((current) => {
      if (checked) return current.includes(taskId) ? current : [...current, taskId];
      return current.filter((id) => id !== taskId);
    });
  };

  const toggleAllTasks = () => {
    setSelectedTaskIds(allTasksSelected ? [] : tasks.map((task) => task.id));
  };

  const handleBuildDrafts = async () => {
    if (selectedTasks.length === 0) {
      message.warning('请先选择要投稿的任务窗口');
      return;
    }

    setPreparingDrafts(true);
    const hideLoading = message.loading('正在准备投稿草稿...', 0);
    try {
      const nextDrafts = await buildNanobananaSubmissionDrafts(selectedTasks, backendMode);
      setDrafts(nextDrafts);
      setActiveIndex(0);
      setUrlInput('');
      setStep('edit');
      const warningCount = nextDrafts.reduce(
        (total, draft) => total + draft.imageWarnings.length,
        0,
      );
      if (warningCount > 0) {
        message.warning('部分图片未能自动填入，可在投稿窗口手动补充');
      }
    } catch (error) {
      console.error(error);
      message.error(error instanceof Error ? error.message : '投稿草稿生成失败');
    } finally {
      hideLoading();
      setPreparingDrafts(false);
    }
  };

  const handleManualSubmission = () => {
    setDrafts([buildManualDraft()]);
    setActiveIndex(0);
    setUrlInput('');
    setStep('edit');
  };

  const patchDraft = (
    draftId: string,
    patch:
      | Partial<OneClickSubmissionDraft>
      | ((draft: OneClickSubmissionDraft) => Partial<OneClickSubmissionDraft>),
  ) => {
    setDrafts((current) =>
      current.map((draft) => {
        if (draft.id !== draftId) return draft;
        const nextPatch = typeof patch === 'function' ? patch(draft) : patch;
        return { ...draft, ...nextPatch };
      }),
    );
  };

  const appendImages = (draftId: string, images: string[]) => {
    patchDraft(draftId, (draft) => ({
      images: Array.from(
        new Set([
          ...draft.images,
          ...images.map((image) => image.trim()).filter(Boolean),
        ]),
      ),
      status: draft.status === 'success' ? 'draft' : draft.status,
      error: undefined,
    }));
  };

  const removeImage = (draftId: string, index: number) => {
    patchDraft(draftId, (draft) => ({
      images: draft.images.filter((_, imageIndex) => imageIndex !== index),
      status: draft.status === 'success' ? 'draft' : draft.status,
      error: undefined,
    }));
  };

  const handleAddUrl = () => {
    if (!activeDraft || !urlInput.trim()) return;
    appendImages(activeDraft.id, [urlInput]);
    setUrlInput('');
  };

  const handleUploadFile: UploadProps['beforeUpload'] = (file) => {
    if (!activeDraft) return false;
    const draftId = activeDraft.id;
    setUploadingImage(true);
    void fileToDataUrl(file)
      .then((dataUrl) => uploadNanobananaImage(dataUrl))
      .then((result) => {
        if (!result.success || !result.url) {
          throw new Error(result.error || '图片上传失败');
        }
        appendImages(draftId, [result.url]);
        message.success('图片已上传');
      })
      .catch((error) => {
        message.error(error instanceof Error ? error.message : '图片上传失败');
      })
      .finally(() => setUploadingImage(false));
    return false;
  };

  const validateDraft = (draft: OneClickSubmissionDraft) => {
    if (!draft.title.trim()) return '标题不能为空';
    if (!draft.content.trim()) return 'Prompt 内容不能为空';
    return '';
  };

  const submitDraft = async (draft: OneClickSubmissionDraft) => {
    const validationError = validateDraft(draft);
    if (validationError) {
      patchDraft(draft.id, { status: 'error', error: validationError });
      return false;
    }

    patchDraft(draft.id, { status: 'submitting', error: undefined });
    const result = await submitNanobananaPrompt(buildPayload(draft));
    if (result.success) {
      patchDraft(draft.id, { status: 'success', error: undefined });
      return true;
    }

    patchDraft(draft.id, {
      status: 'error',
      error: result.error || '投稿失败，请稍后重试',
    });
    return false;
  };

  const handleSubmitCurrent = async () => {
    if (!activeDraft) return;
    const ok = await submitDraft(activeDraft);
    if (ok) message.success('投稿已提交，等待管理员审核');
  };

  const handleSubmitAll = async () => {
    setSubmittingAll(true);
    let successCount = 0;
    try {
      for (const draft of drafts) {
        if (draft.status === 'success') {
          successCount += 1;
          continue;
        }
        const currentDraft = drafts.find((item) => item.id === draft.id) || draft;
        if (await submitDraft(currentDraft)) successCount += 1;
      }
      message.success(`已提交 ${successCount}/${drafts.length} 个投稿`);
    } finally {
      setSubmittingAll(false);
    }
  };

  const selectionFooter = (
    <div className="one-click-submission-footer" style={{ justifyContent: 'flex-end' }}>
      <Space>
        <Button
          icon={<EditOutlined />}
          onClick={handleManualSubmission}
          disabled={preparingDrafts}
        >
          手动投稿
        </Button>
        <Button
          onClick={toggleAllTasks}
          disabled={tasks.length === 0 || preparingDrafts}
        >
          {allTasksSelected ? '清空选择' : '全选任务'}
        </Button>
        <Button
          type="primary"
          icon={<CloudUploadOutlined />}
          loading={preparingDrafts}
          disabled={selectedTasks.length === 0}
          onClick={() => void handleBuildDrafts()}
        >
          生成投稿草稿
        </Button>
      </Space>
    </div>
  );

  const editFooter = (
    <div className="one-click-submission-footer">
      <Space>
        <Button
          onClick={() => {
            setStep('select');
            setUrlInput('');
          }}
          disabled={uploadingImage || submittingAll}
        >
          返回选择
        </Button>
        <Button
          icon={<LeftOutlined />}
          disabled={activeIndex <= 0 || submittingAll}
          onClick={() => setActiveIndex((index) => Math.max(0, index - 1))}
        >
          上一页
        </Button>
        <Button
          icon={<RightOutlined />}
          disabled={activeIndex >= drafts.length - 1 || submittingAll}
          onClick={() => setActiveIndex((index) => Math.min(drafts.length - 1, index + 1))}
        >
          下一页
        </Button>
      </Space>
      <Space>
        <Button
          icon={<SendOutlined />}
          onClick={() => void handleSubmitCurrent()}
          disabled={!activeDraft || uploadingImage || submittingAll || activeDraft.status === 'submitting'}
        >
          投稿当前页
        </Button>
        <Button
          type="primary"
          icon={<CloudUploadOutlined />}
          loading={submittingAll}
          disabled={drafts.length === 0 || uploadingImage}
          onClick={() => void handleSubmitAll()}
        >
          全部投稿
        </Button>
      </Space>
    </div>
  );

  const renderSelection = () => (
    <div className="one-click-submission-select">
      <div className="one-click-submission-select-head">
        <div>
          <Title level={5}>任务窗口</Title>
          <Text type="secondary">已选 {selectedTasks.length}/{tasks.length}</Text>
        </div>
        <Tag color="pink">{NANOBANANA_SUBMISSION_TARGET.label}</Tag>
      </div>
      {tasks.length === 0 ? (
        <Empty description="暂无任务窗口" />
      ) : (
        <div className="one-click-submission-task-list">
          {tasks.map((task, index) => {
            const checked = selectedTaskIdSet.has(task.id);
            return (
              <label
                key={task.id}
                className={`one-click-submission-task-option${checked ? ' is-selected' : ''}`}
              >
                <Checkbox
                  checked={checked}
                  onChange={(event) => toggleTask(task.id, event.target.checked)}
                />
                <span className="one-click-submission-task-index">{index + 1}</span>
                <span className="one-click-submission-task-text">
                  <strong>{getTaskDisplayName(task)}</strong>
                  <small>{getTaskPromptPreview(task)}</small>
                </span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );

  const renderEditor = () => {
    if (drafts.length === 0 || !activeDraft) {
      return <Empty description="暂无投稿草稿" />;
    }

    return (
      <div className="one-click-submission-shell">
        <aside className="one-click-submission-nav">
          {drafts.map((draft, index) => (
            <button
              key={draft.id}
              type="button"
              className={`one-click-submission-nav-item${index === activeIndex ? ' is-active' : ''}`}
              onClick={() => {
                setActiveIndex(index);
                setUrlInput('');
              }}
            >
              <span className="one-click-submission-nav-index">{index + 1}</span>
              <span className="one-click-submission-nav-text">
                <strong>{draft.taskName}</strong>
                <small>{draft.title || '未命名投稿'}</small>
              </span>
              {draft.status === 'success' ? (
                <CheckCircleFilled className="one-click-submission-status-success" />
              ) : draft.status === 'error' ? (
                <CloseCircleFilled className="one-click-submission-status-error" />
              ) : null}
            </button>
          ))}
        </aside>

        <section className="one-click-submission-editor">
          <div className="one-click-submission-editor-head">
            <div>
              <Text type="secondary">任务窗口</Text>
              <Title level={5}>{activeDraft.taskName}</Title>
            </div>
            {getStatusTag(activeDraft)}
          </div>

          {activeDraft.error ? (
            <Alert
              type="error"
              showIcon
              message={activeDraft.error}
              className="one-click-submission-alert"
            />
          ) : null}

          {activeDraft.imageWarnings.length > 0 ? (
            <Alert
              type="warning"
              showIcon
              message="部分图片需要处理"
              description={activeDraft.imageWarnings.join('\n')}
              className="one-click-submission-alert"
            />
          ) : null}

          <div className="one-click-submission-images one-click-submission-images-top">
            <div className="one-click-submission-images-head">
              <Text strong>配图 ({activeDraft.images.length})</Text>
              <Tag color="pink">可编辑</Tag>
            </div>
            <div className="one-click-submission-image-grid">
              <Upload
                accept="image/*"
                multiple
                showUploadList={false}
                beforeUpload={handleUploadFile}
                disabled={uploadingImage}
              >
                <button className="one-click-submission-upload-tile" type="button">
                  {uploadingImage ? <CloudUploadOutlined /> : <UploadOutlined />}
                  <span>{uploadingImage ? '上传中' : '上传图片'}</span>
                </button>
              </Upload>
              {activeDraft.images.map((image, imageIndex) => (
                <div key={`${image}-${imageIndex}`} className="one-click-submission-image-item">
                  <Image src={image} alt="投稿配图" />
                  <Tooltip title="移除图片">
                    <Button
                      danger
                      size="small"
                      shape="circle"
                      icon={<DeleteFilled />}
                      onClick={() => removeImage(activeDraft.id, imageIndex)}
                    />
                  </Tooltip>
                </div>
              ))}
            </div>
            <div className="one-click-submission-url-row">
              <Input
                prefix={<LinkOutlined />}
                value={urlInput}
                onChange={(event) => setUrlInput(event.target.value)}
                onPressEnter={handleAddUrl}
                placeholder="粘贴公网图片链接"
              />
              <Button icon={<PlusOutlined />} disabled={!urlInput.trim()} onClick={handleAddUrl}>
                添加
              </Button>
            </div>
          </div>

          <div className="one-click-submission-form-grid">
            <label className="one-click-submission-field">
              <Text strong>标题</Text>
              <Input
                value={activeDraft.title}
                maxLength={80}
                onChange={(event) =>
                  patchDraft(activeDraft.id, {
                    title: event.target.value,
                    status: activeDraft.status === 'success' ? 'draft' : activeDraft.status,
                    error: undefined,
                  })
                }
                placeholder="给投稿起个标题"
              />
            </label>
            <label className="one-click-submission-field">
              <Text strong>投稿人 ID</Text>
              <Input
                value={activeDraft.contributor}
                onChange={(event) =>
                  patchDraft(activeDraft.id, {
                    contributor: event.target.value,
                    status: activeDraft.status === 'success' ? 'draft' : activeDraft.status,
                    error: undefined,
                  })
                }
                placeholder="不填则为匿名"
              />
            </label>
          </div>

          <label className="one-click-submission-field one-click-submission-note-field">
            <span className="one-click-submission-note-label">
              <InfoCircleFilled />
              <span>投稿者备注</span>
            </span>
            <TextArea
              className="one-click-submission-note-textarea"
              value={activeDraft.notes}
              rows={3}
              onChange={(event) =>
                patchDraft(activeDraft.id, {
                  notes: event.target.value,
                  status: activeDraft.status === 'success' ? 'draft' : activeDraft.status,
                  error: undefined,
                })
              }
              placeholder="可填写使用技巧、模型说明或注意事项"
            />
          </label>

          <label className="one-click-submission-field">
            <Text strong>Prompt 内容</Text>
            <TextArea
              value={activeDraft.content}
              rows={8}
              onChange={(event) =>
                patchDraft(activeDraft.id, {
                  content: event.target.value,
                  status: activeDraft.status === 'success' ? 'draft' : activeDraft.status,
                  error: undefined,
                })
              }
              placeholder="填写要投稿的提示词"
            />
          </label>

          <label className="one-click-submission-field">
            <Text strong>标签</Text>
            <Select
              mode="tags"
              value={activeDraft.tags}
              loading={tagsLoading}
              tokenSeparators={[',', '，', ' ']}
              onChange={(tags) =>
                patchDraft(activeDraft.id, {
                  tags,
                  status: activeDraft.status === 'success' ? 'draft' : activeDraft.status,
                  error: undefined,
                })
              }
              placeholder="选择或输入标签后回车"
              options={tagOptions}
            />
          </label>
        </section>
      </div>
    );
  };

  return (
    <Modal
      className="one-click-submission-modal"
      open={open}
      width={980}
      title={
        <div className="one-click-submission-title">
          <div>
            <Title level={4}>一键投稿</Title>
            <Text type="secondary">投稿目标：{NANOBANANA_SUBMISSION_TARGET.label}</Text>
          </div>
          <Badge
            count={step === 'select' ? `${selectedTasks.length}/${tasks.length}` : `${doneCount}/${drafts.length}`}
            color="#FF9EB5"
          />
        </div>
      }
      footer={step === 'select' ? selectionFooter : editFooter}
      onCancel={onClose}
      maskClosable={!preparingDrafts && !submittingAll}
      destroyOnClose
    >
      {step === 'select' ? renderSelection() : renderEditor()}
    </Modal>
  );
};

export default OneClickSubmissionModal;
