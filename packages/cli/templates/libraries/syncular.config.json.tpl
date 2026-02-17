{
  "mode": <%= it.MODE_JSON %>,
  "targets": <%= it.TARGETS_JSON %>,
  "dialects": <%= it.DIALECTS_JSON %>,
  "migrate": {
    "adapter": "<%= it.ADAPTER_PATH %>",
    "export": "<%= it.ADAPTER_EXPORT %>"
  }
}
