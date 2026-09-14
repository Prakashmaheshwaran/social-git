variable "IMAGE_NAME" {
  default = "social-git-runtime"
}

variable "IMAGE_TAG" {
  default = "local"
}

variable "OCI_OUTPUT" {
  default = "dist/social-git-runtime.oci.tar"
}

variable "SOURCE_DATE_EPOCH" {
  default = "0"
}

variable "CREATED" {
  default = "1970-01-01T00:00:00Z"
}

variable "VCS_REF" {
  default = "unknown"
}

group "default" {
  targets = ["runtime"]
}

target "runtime" {
  context = "."
  dockerfile = "Dockerfile"
  tags = ["${IMAGE_NAME}:${IMAGE_TAG}"]
  platforms = ["linux/amd64", "linux/arm64"]
  args = {
    CREATED = CREATED
    SOURCE_DATE_EPOCH = SOURCE_DATE_EPOCH
    VCS_REF = VCS_REF
  }
  output = ["type=oci,dest=${OCI_OUTPUT},rewrite-timestamp=true"]
  provenance = false
  sbom = false
}
