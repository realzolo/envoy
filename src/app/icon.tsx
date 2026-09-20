import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          alignItems: "center",
          background: "#f4f4f5",
          borderRadius: 7,
          color: "#09090b",
          display: "flex",
          fontSize: 18,
          fontWeight: 700,
          height: "100%",
          justifyContent: "center",
          width: "100%",
        }}
      >
        E
      </div>
    ),
    size,
  );
}
