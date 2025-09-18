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
} from "antd";
import { UploadOutlined } from "@ant-design/icons";
import Peer from "peerjs";
import type { DataConnection } from "peerjs";
import { useState, useRef, useEffect } from "react";

const { Title, Text } = Typography;

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  const [myId, setMyId] = useState("");
  const [connectToId, setConnectToId] = useState("");
  const [connected, setConnected] = useState(false);
  const [connectedTo, setConnectedTo] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [files, setFiles] = useState<
    {
      name: string;
      url: string | null;
      progress: number;
      status: "receiving" | "done" | "cancelled";
    }[]
  >([]);
  const [sendingFiles, setSendingFiles] = useState<
    {
      name: string;
      progress: number;
      status: "sending" | "done" | "cancelled";
    }[]
  >([]);

  const peerRef = useRef<Peer | null>(null);
  const connectionRef = useRef<DataConnection | null>(null);
  const fileChunksRef = useRef<Record<string, BlobPart[]>>({});
  const activeTransfersRef = useRef<Record<string, { cancelled: boolean }>>({});

  useEffect(() => {
    const peer = new Peer();
    peer.on("open", function (id) {
      setMyId(id);
    });
    peer.on("connection", function (conn) {
      connectionRef.current = conn;
      conn.on("open", function () {
        setConnectedTo(conn.peer);
        setConnected(true);
        conn.on("data", acceptFile);
      });
    });
    peerRef.current = peer;

    return () => {
      if (peerRef.current) {
        peerRef.current.destroy();
      }
    };
  }, []);

  const connectToPeer = () => {
    if (!peerRef.current || !connectToId.trim()) return;

    setConnecting(true);
    try {
      const conn = peerRef.current.connect(connectToId.trim());
      connectionRef.current = conn;

      conn.on("open", function () {
        setConnectedTo(conn.peer);
        setConnected(true);
        setConnecting(false);
        conn.on("data", acceptFile);
      });

      conn.on("error", function (err) {
        setConnecting(false);
        alert("Failed to connect to peer");
        console.error("Connection error:", err);
      });
    } catch (error) {
      setConnecting(false);
      alert("Failed to connect to peer");
      console.error("Failed to connect:", error);
    }
  };

  const sendFile = (fileList: any[]) => {
    if (!connectionRef.current || !connectionRef.current.open) {
      alert("No device connected.");
      return;
    }

    const uploadedFile = fileList[0];
    if (!uploadedFile) return;

    const actualFile = uploadedFile.originFileObj;
    if (!actualFile) return;

    const CHUNK_SIZE = 1024 * 1024;
    const fileReader = new FileReader();
    let currentPosition = 0;

    addFileToSendingList(actualFile.name);

    fileReader.onload = (event) => {
      const fileData = event.target?.result as ArrayBuffer;
      if (!fileData) return;

      const fileSize = actualFile.size;
      const fileType = actualFile.type;
      const fileName = actualFile.name;

      activeTransfersRef.current[fileName] = { cancelled: false };

      sendNextChunk();

      function sendNextChunk() {
        if (activeTransfersRef.current[fileName]?.cancelled) return;

        const endPosition = Math.min(currentPosition + CHUNK_SIZE, fileSize);
        const chunk = fileData.slice(currentPosition, endPosition);
        const isThisTheLastChunk = endPosition >= fileSize;

        const progressPercentage = Math.round((endPosition / fileSize) * 100);

        connectionRef.current?.send({
          chunk: chunk,
          isLast: isThisTheLastChunk,
          mimeType: fileType,
          fileName: fileName,
          progress: progressPercentage,
        });

        currentPosition = endPosition;

        updateSendingProgress(fileName, progressPercentage);

        if (!isThisTheLastChunk) {
          setTimeout(sendNextChunk, 0);
        } else {
          markFileAsSent(fileName);
          delete activeTransfersRef.current[fileName];
        }
      }
    };

    fileReader.readAsArrayBuffer(actualFile);
  };

  const addFileToSendingList = (fileName: string) => {
    setSendingFiles((currentFiles) => {
      const fileAlreadyExists = currentFiles.find(
        (file) => file.name === fileName
      );

      if (fileAlreadyExists) {
        return currentFiles.map((file) =>
          file.name === fileName
            ? { ...file, progress: 0, status: "sending" }
            : file
        );
      } else {
        return [
          ...currentFiles,
          { name: fileName, progress: 0, status: "sending" },
        ];
      }
    });
  };

  const updateSendingProgress = (
    fileName: string,
    progressPercentage: number
  ) => {
    setSendingFiles((currentFiles) =>
      currentFiles.map((file) =>
        file.name === fileName
          ? { ...file, progress: progressPercentage }
          : file
      )
    );
  };

  const markFileAsSent = (fileName: string) => {
    setSendingFiles((currentFiles) =>
      currentFiles.map((file) =>
        file.name === fileName
          ? { ...file, progress: 100, status: "done" }
          : file
      )
    );
  };

  const cancelSendingFile = (fileName: string) => {
    if (activeTransfersRef.current[fileName]) {
      activeTransfersRef.current[fileName].cancelled = true;

      connectionRef.current?.send({ type: "cancel", fileName });

      setSendingFiles((prev) =>
        prev.map((f) =>
          f.name === fileName ? { ...f, status: "cancelled" } : f
        )
      );
    }
  };

  type FileChunkData = {
    chunk: BlobPart;
    isLast: boolean;
    mimeType?: string;
    fileName?: string;
    progress?: number;
    type?: string;
  };

  const acceptFile = (incomingData: unknown) => {
    const receivedData = incomingData as FileChunkData;

    if (receivedData?.type === "cancel") {
      handleFileCancellation(receivedData);
      return;
    }

    if (isValidFileChunk(receivedData)) {
      processFileChunk(receivedData);
    } else {
      alert("Not a File.");
    }
  };

  const handleFileCancellation = (cancelData: FileChunkData) => {
    const fileName = cancelData.fileName;

    if (fileName) {
      delete fileChunksRef.current[fileName];

      setFiles((currentFiles) =>
        currentFiles.map((file) =>
          file.name === fileName ? { ...file, status: "cancelled" } : file
        )
      );
    }
  };

  const isValidFileChunk = (data: any) => {
    return (
      typeof data === "object" &&
      data !== null &&
      "chunk" in data &&
      "isLast" in data
    );
  };

  const processFileChunk = (chunkData: FileChunkData) => {
    const fileName = chunkData.fileName || "download";
    const fileType = chunkData.mimeType || "application/octet-stream";
    const currentProgress = chunkData.progress || 0;
    const isLastChunk = chunkData.isLast;
    const fileChunk = chunkData.chunk;

    if (!fileChunksRef.current[fileName]) {
      setupNewIncomingFile(fileName);
    }

    fileChunksRef.current[fileName].push(fileChunk);

    updateReceivingProgress(fileName, currentProgress, isLastChunk);

    if (isLastChunk) {
      createCompleteFile(fileName, fileType);
    }
  };

  const setupNewIncomingFile = (fileName: string) => {
    fileChunksRef.current[fileName] = [];

    setFiles((currentFiles) => {
      const fileAlreadyExists = currentFiles.find(
        (file) => file.name === fileName
      );

      if (fileAlreadyExists) {
        return currentFiles.map((file) =>
          file.name === fileName
            ? { ...file, url: null, progress: 0, status: "receiving" }
            : file
        );
      } else {
        return [
          ...currentFiles,
          {
            name: fileName,
            url: null,
            progress: 0,
            status: "receiving",
          },
        ];
      }
    });
  };

  const updateReceivingProgress = (
    fileName: string,
    progressPercentage: number,
    isComplete: boolean
  ) => {
    setFiles((currentFiles) =>
      currentFiles.map((file) =>
        file.name === fileName
          ? {
              ...file,
              progress: isComplete ? 100 : progressPercentage,
              status: isComplete ? "done" : "receiving",
            }
          : file
      )
    );
  };

  const createCompleteFile = (fileName: string, fileType: string) => {
    const allChunks = fileChunksRef.current[fileName];
    const completeFile = new Blob(allChunks, { type: fileType });

    const downloadUrl = URL.createObjectURL(completeFile);

    setFiles((currentFiles) =>
      currentFiles.map((file) =>
        file.name === fileName
          ? {
              ...file,
              url: downloadUrl,
              progress: 100,
              status: "done",
            }
          : file
      )
    );

    fileChunksRef.current[fileName] = [];
  };

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-6">
      <Card
        className="w-full max-w-2xl shadow-xl rounded-2xl border border-gray-200"
        style={{ background: "#ffffff" }}
      >
        <div className="text-center mb-6">
          <Title level={3} className="!mb-1">
            🔗 P2P File Sharing
          </Title>
          <Text type="secondary">
            Connect with peers and share files directly
          </Text>
        </div>

        <Card className="mb-6 rounded-lg shadow-sm bg-gray-50">
          <Text strong>My ID:</Text>
          {myId ? (
            <div className="mt-2 flex gap-2">
              <Input
                value={myId}
                readOnly
                className="font-mono"
                style={{ backgroundColor: "#f9f9f9" }}
              />
            </div>
          ) : (
            <div className="mt-2">
              <Spin size="small" /> Generating peer ID...
            </div>
          )}
        </Card>

        <Card className="mb-6 rounded-lg shadow-sm bg-gray-50">
          <Text strong>Connect to Peer:</Text>
          <div className="mt-3 flex gap-2">
            <Input
              placeholder="Enter Peer ID"
              value={connectToId}
              onChange={(e) => setConnectToId(e.target.value)}
              disabled={connected}
              onPressEnter={connectToPeer}
            />
            <Button
              type="primary"
              onClick={connectToPeer}
              disabled={!myId || connected || !connectToId.trim() || connecting}
              loading={connecting}
            >
              {connecting ? "Connecting..." : "Connect"}
            </Button>
          </div>
          <div className="mt-3">
            {connected ? (
              <Tag color="green" className="px-3 py-1 text-sm rounded-full">
                Connected to {connectedTo}
              </Tag>
            ) : (
              <Tag color="red" className="px-3 py-1 text-sm rounded-full">
                Not Connected
              </Tag>
            )}
          </div>
        </Card>

        <Card className="mb-6 rounded-lg shadow-sm bg-gray-50">
          <Text strong>Send File</Text>
          <div className="mt-4 text-center">
            <Upload
              beforeUpload={() => false}
              showUploadList={false}
              disabled={!connected}
              onChange={(info) => {
                if (info.fileList.length > 0) {
                  const latestFile = info.fileList[info.fileList.length - 1];
                  sendFile([latestFile]);
                }
              }}
            >
              <Button
                icon={<UploadOutlined />}
                disabled={!connected}
                size="large"
                type="dashed"
              >
                Select File
              </Button>
            </Upload>
            {!connected && (
              <p className="text-gray-400 text-xs mt-2">
                Connect to a peer to enable file sharing
              </p>
            )}
          </div>

          {sendingFiles.map((f) => (
            <div key={f.name} className="mt-4">
              <div className="flex justify-between items-center mb-1">
                <Text className="text-sm">{f.name}</Text>
                {f.status === "sending" && (
                  <Button
                    danger
                    size="small"
                    onClick={() => cancelSendingFile(f.name)}
                  >
                    Cancel
                  </Button>
                )}
              </div>
              <Progress
                percent={f.progress}
                status={
                  f.status === "done"
                    ? "success"
                    : f.status === "cancelled"
                      ? "exception"
                      : "active"
                }
              />
            </div>
          ))}
        </Card>

        {files.length > 0 && (
          <Card className="rounded-lg shadow-sm bg-gray-50">
            <Text strong>Received Files</Text>
            {files.map((f) => (
              <div key={f.name} className="mt-4">
                <div className="flex justify-between items-center mb-1">
                  <Text className="text-sm">{f.name}</Text>
                  {f.url && f.status === "done" && (
                    <Button type="primary" size="small">
                      <a
                        href={f.url}
                        download={f.name}
                        className="text-white no-underline"
                      >
                        Download
                      </a>
                    </Button>
                  )}
                </div>
                <Progress
                  percent={f.progress}
                  status={
                    f.status === "done"
                      ? "success"
                      : f.status === "cancelled"
                        ? "exception"
                        : "active"
                  }
                />
              </div>
            ))}
          </Card>
        )}
      </Card>
    </div>
  );
}
