import { useEffect, useState } from "react";

export default function InstanceLogo({ iconUrl, fallback, className = "" }) {
  const [failedUrl, setFailedUrl] = useState("");

  useEffect(() => {
    setFailedUrl("");
  }, [iconUrl]);

  if (iconUrl && failedUrl !== iconUrl) {
    return (
      <img
        className={`instance-logo-image ${className}`.trim()}
        src={iconUrl}
        alt=""
        onError={() => setFailedUrl(iconUrl)}
      />
    );
  }

  return fallback;
}
