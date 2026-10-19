package androidx.camera.core;
public final class ImageAnalysis extends UseCase {
  public static final int STRATEGY_KEEP_ONLY_LATEST = 0, STRATEGY_BLOCK_PRODUCER = 1;
  public static final int OUTPUT_IMAGE_FORMAT_YUV_420_888 = 1, OUTPUT_IMAGE_FORMAT_RGBA_8888 = 2;
  public interface Analyzer { void analyze(ImageProxy image); }
  public void setAnalyzer(java.util.concurrent.Executor executor, Analyzer analyzer) {}
  public void clearAnalyzer() {}
  public ResolutionInfo getResolutionInfo() { return null; }
  public static final class Builder implements ExtendableBuilder<ImageAnalysis> {
    public Builder() {}
    public Builder setBackpressureStrategy(int s) { return this; }
    public Builder setOutputImageFormat(int f) { return this; }
    public Builder setImageQueueDepth(int d) { return this; }
    public Builder setResolutionSelector(androidx.camera.core.resolutionselector.ResolutionSelector r) { return this; }
    public Builder setTargetRotation(int r) { return this; }
    public ImageAnalysis build() { return null; }
  }
}