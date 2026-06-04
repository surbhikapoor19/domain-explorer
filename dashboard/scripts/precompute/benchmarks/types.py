from dataclasses import dataclass, field
from typing import Optional

@dataclass
class ResultRecord:
    paper_id: str
    method_raw: str
    method_id: Optional[str]
    metric_raw: str
    metric_id: Optional[str]
    unit: Optional[str]
    higher_is_better: Optional[bool]
    dataset_raw: str = ""
    dataset_id: Optional[str] = None
    condition: Optional[str] = None
    value: Optional[float] = None
    value_str: str = ""
    std_dev: Optional[float] = None
    is_own_method: bool = False
    is_ablation: bool = False
    extractor: str = "tei_table"
    table_caption: str = ""
    section_label: str = ""
    page: Optional[int] = None
    bbox: Optional[list] = None
    crop_image: Optional[str] = None
    extraction_conf: str = "medium"
    verified: bool = False

    def comparison_key(self):
        return (self.method_id, self.metric_id, self.dataset_id, self.condition)
