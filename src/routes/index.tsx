import { createFileRoute } from "@tanstack/react-router";
import {
  Typography,
  Button,
  Input,
  Card,
  Upload,
  Progress,
  Tag,
  Spin,
  Steps,
  Space,
  Alert,
  Tooltip,
  Row,
  Col,
  message,
  theme,
} from "antd";
import {
  UploadOutlined,
  CopyOutlined,
  InfoCircleOutlined,
  DownloadOutlined,
} from "@ant-design/icons";
import Peer from "peerjs";
import type { DataConnection } from "peerjs";
import { useState, useRef, useEffect } from "react";

const { Title, Text, Paragraph } = Typography;
const { useToken } = theme;

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  const { token } = useToken();
  const [messageApi, contextHolder] = message.useMessage();

  const [myId, setMyId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [isConnected, setIsConnected] = useState(false);
  const [connectedPeer, setConnectedPeer] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);

  const [receivedFiles, setReceivedFiles] = useState<
    {
      name: string;
      downloadUrl: string | null;
      percent: number;
      status: "receiving" | "done" | "cancelled";
      totalSize: number;
      receivedSize: number;
    }[]
  >([]);

  const [sentFiles, setSentFiles] = useState<
    {
      name: string;
      percent: number;
      status: "sending" | "done" | "cancelled";
    }[]
  >([]);

  const peer = useRef<Peer | null>(null);
  const connection = useRef<DataConnection | null>(null);
  const fileChunks = useRef<Record<string, BlobPart[]>>({});
  const fileMetadata = useRef<Record<string, { size: number; type: string }>>(
    {}
  );
  const cancelledTransfers = useRef<Record<string, boolean>>({});

  useEffect(() => {
    const newPeer = new Peer();

    newPeer.on("open", function (id) {
      setMyId(id);
    });

    newPeer.on("connection", function (conn) {
      connection.current = conn;
      conn.on("open", function () {
        setConnectedPeer(conn.peer);
        setIsConnected(true);
        messageApi.success(`Connected to peer: ${conn.peer}`);
        conn.on("data", handleIncomingData);
      });
    });

    newPeer.on("error", function (err) {
      messageApi.error("Failed to initialize peer connection");
      console.error("Peer error:", err);
    });

    peer.current = newPeer;

    return () => {
      if (peer.current) {
        peer.current.destroy();
      }
    };
  }, [messageApi]);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    messageApi.success("ID copied to clipboard!");
  };

  const connectToPeer = () => {
    if (!peer.current || !targetId.trim()) return;

    setIsConnecting(true);
    try {
      const conn = peer.current.connect(targetId.trim());
      connection.current = conn;

      conn.on("open", function () {
        setConnectedPeer(conn.peer);
        setIsConnected(true);
        setIsConnecting(false);
        messageApi.success(`Successfully connected to ${conn.peer}`);
        conn.on("data", handleIncomingData);
      });

      conn.on("error", function (err) {
        setIsConnecting(false);
        messageApi.error("Failed to connect to peer!");
        console.error("Connection error:", err);
      });
    } catch (error) {
      setIsConnecting(false);
      messageApi.error("Failed to establish connection");
      console.error("Failed to connect:", error);
    }
  };

  const sendFile = (fileList: any[]) => {
    if (!connection.current || !connection.current.open) {
      messageApi.warning(
        "No device connected. Please connect to a peer first."
      );
      return;
    }

    const uploadedFile = fileList[0];
    if (!uploadedFile) return;

    const file = uploadedFile.originFileObj;
    if (!file) return;

    const CHUNK_SIZE = 1024 * 1024;
    const reader = new FileReader();
    let position = 0;

    addToSentList(file.name);
    messageApi.info(`Started sending: ${file.name}`);

    reader.onload = (event) => {
      const fileData = event.target?.result as ArrayBuffer;
      if (!fileData) return;

      const fileName = file.name;
      const fileSize = file.size;
      const fileType = file.type;

      cancelledTransfers.current[fileName] = false;

      connection.current?.send({
        type: "metadata",
        fileName: fileName,
        fileSize: fileSize,
        fileType: fileType,
      });

      sendNextChunk();

      function sendNextChunk() {
        if (cancelledTransfers.current[fileName]) return;

        const endPos = Math.min(position + CHUNK_SIZE, fileSize);
        const chunk = fileData.slice(position, endPos);
        const isLast = endPos >= fileSize;
        const percent = Math.round((endPos / fileSize) * 100);

        connection.current?.send({
          type: "chunk",
          chunk: chunk,
          isLast: isLast,
          fileName: fileName,
        });

        position = endPos;
        updateSentProgress(fileName, percent);

        if (!isLast) {
          setTimeout(sendNextChunk, 10);
        } else {
          markSentComplete(fileName);
        }
      }
    };

    reader.readAsArrayBuffer(file);
  };

  const addToSentList = (fileName: string) => {
    setSentFiles((current) => {
      const exists = current.find((f) => f.name === fileName);

      if (exists) {
        return current.map((f) =>
          f.name === fileName ? { ...f, percent: 0, status: "sending" } : f
        );
      } else {
        return [...current, { name: fileName, percent: 0, status: "sending" }];
      }
    });
  };

  const updateSentProgress = (fileName: string, percent: number) => {
    setSentFiles((current) =>
      current.map((f) => (f.name === fileName ? { ...f, percent: percent } : f))
    );
  };

  const markSentComplete = (fileName: string) => {
    setSentFiles((current) =>
      current.map((f) =>
        f.name === fileName ? { ...f, percent: 100, status: "done" } : f
      )
    );
  };

  const cancelSending = (fileName: string) => {
    cancelledTransfers.current[fileName] = true;

    connection.current?.send({
      type: "cancel",
      fileName: fileName,
    });

    setSentFiles((current) =>
      current.map((f) =>
        f.name === fileName ? { ...f, status: "cancelled" } : f
      )
    );
  };

  const handleIncomingData = (data: any) => {
    if (data?.type === "metadata") {
      handleFileMetadata(data);
    } else if (data?.type === "chunk") {
      handleFileChunk(data);
    } else if (data?.type === "cancel") {
      handleCancel(data);
    }
  };

  const handleFileMetadata = (data: any) => {
    const { fileName, fileSize, fileType } = data;

    fileMetadata.current[fileName] = { size: fileSize, type: fileType };
    fileChunks.current[fileName] = [];

    setReceivedFiles((current) => {
      const exists = current.find((f) => f.name === fileName);

      if (exists) {
        return current.map((f) =>
          f.name === fileName
            ? {
                ...f,
                downloadUrl: null,
                percent: 0,
                status: "receiving",
                totalSize: fileSize,
                receivedSize: 0,
              }
            : f
        );
      } else {
        return [
          ...current,
          {
            name: fileName,
            downloadUrl: null,
            percent: 0,
            status: "receiving",
            totalSize: fileSize,
            receivedSize: 0,
          },
        ];
      }
    });
  };

  const handleFileChunk = (data: any) => {
    const { chunk, isLast, fileName } = data;

    if (!fileChunks.current[fileName]) return;

    fileChunks.current[fileName].push(chunk);

    const metadata = fileMetadata.current[fileName];
    if (!metadata) return;

    const currentSize = fileChunks.current[fileName].length * 1024 * 1024;
    const actualSize = Math.min(currentSize, metadata.size);
    const percent = Math.round((actualSize / metadata.size) * 100);

    setReceivedFiles((current) =>
      current.map((f) =>
        f.name === fileName
          ? {
              ...f,
              percent: isLast ? 100 : percent,
              status: isLast ? "done" : "receiving",
              receivedSize: actualSize,
            }
          : f
      )
    );

    if (isLast) {
      createDownloadFile(fileName);
    }
  };

  const handleCancel = (data: any) => {
    const fileName = data.fileName;

    if (fileName && fileChunks.current[fileName]) {
      delete fileChunks.current[fileName];
      delete fileMetadata.current[fileName];

      setReceivedFiles((current) =>
        current.map((f) =>
          f.name === fileName ? { ...f, status: "cancelled" } : f
        )
      );
    }
  };

  const createDownloadFile = (fileName: string) => {
    const chunks = fileChunks.current[fileName];
    const metadata = fileMetadata.current[fileName];

    if (!chunks || !metadata) return;

    const completeFile = new Blob(chunks, { type: metadata.type });
    const url = URL.createObjectURL(completeFile);

    setReceivedFiles((current) =>
      current.map((f) =>
        f.name === fileName
          ? {
              ...f,
              downloadUrl: url,
              percent: 100,
              status: "done",
            }
          : f
      )
    );

    delete fileChunks.current[fileName];
    delete fileMetadata.current[fileName];
  };

  const getCurrentStep = () => {
    if (!myId) return 0;
    if (!isConnected) return 1;
    return 2;
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  return (
    <>
      {contextHolder}
      <div
        className="min-h-screen p-4 sm:p-6"
        style={{
          background: `linear-gradient(135deg, ${token.colorBgContainer} 0%, ${token.colorPrimaryBg} 100%)`,
        }}
      >
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-8">
            <Title level={1} className="!mb-2">
              🔗 P2P File Sharing
            </Title>
            <Paragraph className="text-lg" type="secondary">
              Share files directly between devices
            </Paragraph>
          </div>

          <Row gutter={[24, 24]} className="mb-6">
            <Col xs={24} lg={8}>
              <Card
                className="h-full shadow-sm"
                styles={{
                  body: { padding: "24px" },
                  header: {
                    borderBottom: `1px solid ${token.colorBorderSecondary}`,
                  },
                }}
                title={
                  <div className="flex items-center">
                    <InfoCircleOutlined className="mr-2" />
                    How to Use
                  </div>
                }
              >
                <Steps
                  direction="vertical"
                  current={getCurrentStep()}
                  className="custom-steps"
                  items={[
                    {
                      title: (
                        <span className="text-black font-semibold">
                          Generate Your ID
                        </span>
                      ),
                      description: (
                        <div className="text-gray-700">
                          Wait for your unique peer ID to be generated
                          automatically
                        </div>
                      ),
                    },
                    {
                      title: (
                        <span className="text-black font-semibold">
                          Connect to Peer
                        </span>
                      ),
                      description: (
                        <div className="text-gray-700">
                          Share your ID with someone or enter their ID to
                          connect
                        </div>
                      ),
                    },
                    {
                      title: (
                        <span className="text-black font-semibold">
                          Share Files
                        </span>
                      ),
                      description: (
                        <div className="text-gray-700">
                          Select and send files directly to the connected peer
                        </div>
                      ),
                    },
                  ]}
                />

                {isConnected && (
                  <Alert
                    message="Ready to Share!"
                    description="You can now send and receive files"
                    type="success"
                    showIcon
                    className="mt-4"
                  />
                )}
              </Card>
            </Col>

            <Col xs={24} lg={16}>
              <Space direction="vertical" className="w-full" size="large">
                <Card
                  className="shadow-sm"
                  title={<div className="flex items-center">Your Peer ID</div>}
                >
                  {myId ? (
                    <div className="flex gap-3">
                      <Input
                        value={myId}
                        readOnly
                        className="font-mono"
                        size="large"
                        style={{
                          backgroundColor: token.colorFillTertiary,
                        }}
                      />
                      <Tooltip title="Copy ID to clipboard">
                        <Button
                          icon={<CopyOutlined />}
                          onClick={() => copyToClipboard(myId)}
                          size="large"
                          type="primary"
                        >
                          Copy
                        </Button>
                      </Tooltip>
                    </div>
                  ) : (
                    <div className="flex items-center py-2">
                      <Spin className="mr-3" />
                      <Text>Generating your unique peer ID...</Text>
                    </div>
                  )}
                </Card>
                <Card
                  className="shadow-sm"
                  title={
                    <div className="flex items-center">Connect to Peer</div>
                  }
                >
                  <Space direction="vertical" className="w-full" size="middle">
                    <div className="flex gap-3">
                      <Input
                        placeholder="Enter the other person's Peer ID"
                        value={targetId}
                        onChange={(e) => setTargetId(e.target.value)}
                        disabled={isConnected}
                        onPressEnter={connectToPeer}
                        size="large"
                        style={{ flex: 1 }}
                      />
                      <Button
                        type="primary"
                        onClick={connectToPeer}
                        disabled={
                          !myId ||
                          isConnected ||
                          !targetId.trim() ||
                          isConnecting
                        }
                        loading={isConnecting}
                        size="large"
                      >
                        {isConnecting ? "Connecting..." : "Connect"}
                      </Button>
                    </div>

                    <div>
                      {isConnected ? (
                        <Tag color="success" className="px-3 py-1">
                          Connected to {connectedPeer}
                        </Tag>
                      ) : (
                        <Tag color="error" className="px-3 py-1">
                          Not Connected
                        </Tag>
                      )}
                    </div>
                  </Space>
                </Card>
              </Space>
            </Col>
          </Row>

          <Row gutter={[24, 24]}>
            <Col xs={24} lg={12}>
              <Card
                className="shadow-sm h-full"
                title={<div className="flex items-center">Send Files</div>}
              >
                <div className="text-center mb-6">
                  <Upload.Dragger
                    beforeUpload={() => false}
                    showUploadList={false}
                    disabled={!isConnected}
                    onChange={(info) => {
                      if (info.fileList.length > 0) {
                        const latestFile =
                          info.fileList[info.fileList.length - 1];
                        sendFile([latestFile]);
                      }
                    }}
                    style={{
                      backgroundColor: isConnected
                        ? token.colorPrimaryBg
                        : token.colorFillTertiary,
                      borderColor: isConnected
                        ? token.colorPrimary
                        : token.colorBorder,
                    }}
                  >
                    <p className="ant-upload-drag-icon">
                      <UploadOutlined
                        style={{
                          fontSize: "3rem",
                          color: isConnected
                            ? token.colorPrimary
                            : token.colorTextTertiary,
                        }}
                      />
                    </p>
                    <p
                      className="ant-upload-text"
                      style={{ fontSize: "1.1rem" }}
                    >
                      {isConnected
                        ? "Click or drag file to upload"
                        : "Connect to enable file sharing"}
                    </p>
                    <p className="ant-upload-hint">
                      {isConnected
                        ? "Select any file to send to the connected peer"
                        : "You need to connect to another peer first"}
                    </p>
                  </Upload.Dragger>
                </div>

                <div className="space-y-4">
                  {sentFiles.map((f, index) => (
                    <Card
                      key={`${f.name}-${index}`}
                      size="small"
                      className={`${
                        f.status === "done"
                          ? "bg-green-50 border-green-200"
                          : f.status === "cancelled"
                            ? "bg-red-50 border-red-200"
                            : "bg-blue-50 border-blue-200"
                      }`}
                    >
                      <div className="flex justify-between items-start mb-3">
                        <div className="flex-1 min-w-0">
                          <Text strong className="block truncate">
                            {f.name}
                          </Text>
                          <Text type="secondary" className="text-sm">
                            {f.status === "sending" &&
                              `Sending... ${f.percent}%`}
                            {f.status === "done" && "Sent successfully"}
                            {f.status === "cancelled" && "Cancelled"}
                          </Text>
                        </div>
                        {f.status === "sending" && (
                          <Button
                            danger
                            size="small"
                            onClick={() => cancelSending(f.name)}
                          >
                            Cancel
                          </Button>
                        )}
                      </div>
                      <Progress
                        percent={f.percent}
                        status={
                          f.status === "done"
                            ? "success"
                            : f.status === "cancelled"
                              ? "exception"
                              : "active"
                        }
                        strokeWidth={6}
                      />
                    </Card>
                  ))}
                </div>
              </Card>
            </Col>

            <Col xs={24} lg={12}>
              <Card
                className="shadow-sm h-full"
                title={
                  <div className="flex items-center">
                    Received Files
                    {receivedFiles.length > 0 && (
                      <Tag color="blue" className="ml-2">
                        {receivedFiles.length}
                      </Tag>
                    )}
                  </div>
                }
              >
                {receivedFiles.length === 0 ? (
                  <div className="text-center py-12">
                    <DownloadOutlined
                      style={{
                        fontSize: "3rem",
                        color: token.colorTextTertiary,
                        marginBottom: "1rem",
                      }}
                    />
                    <Text type="secondary" className="block text-lg">
                      No files received yet
                    </Text>
                    <Text type="secondary">
                      Files sent to you will appear here
                    </Text>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {receivedFiles.map((f, index) => (
                      <Card
                        key={`${f.name}-${index}`}
                        size="small"
                        className={`${
                          f.status === "done"
                            ? "bg-green-50 border-green-200"
                            : f.status === "cancelled"
                              ? "bg-red-50 border-red-200"
                              : "bg-orange-50 border-orange-200"
                        }`}
                      >
                        <div className="flex justify-between items-start mb-3">
                          <div className="flex-1 min-w-0">
                            <Text strong className="block truncate">
                              {f.name}
                            </Text>
                            <Text type="secondary" className="text-sm">
                              {f.status === "receiving" &&
                                `Receiving... ${formatFileSize(f.receivedSize)} / ${formatFileSize(f.totalSize)}`}
                              {f.status === "done" &&
                                `Ready to download (${formatFileSize(f.totalSize)})`}
                              {f.status === "cancelled" && "Transfer cancelled"}
                            </Text>
                          </div>
                          {f.downloadUrl && f.status === "done" && (
                            <Button type="primary" size="small">
                              <a
                                href={f.downloadUrl}
                                download={f.name}
                                className="text-white no-underline"
                              >
                                <DownloadOutlined className="mr-1" />
                                Download
                              </a>
                            </Button>
                          )}
                        </div>
                        <Progress
                          percent={f.percent}
                          status={
                            f.status === "done"
                              ? "success"
                              : f.status === "cancelled"
                                ? "exception"
                                : "active"
                          }
                          strokeWidth={6}
                        />
                      </Card>
                    ))}
                  </div>
                )}
              </Card>
            </Col>
          </Row>
        </div>
      </div>
    </>
  );
}
