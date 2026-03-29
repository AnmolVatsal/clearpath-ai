class DecisionEngine:
    def __init__(self, rules):
        self.rules = rules

    def evaluate(self, patient, diagnosis, procedure):
        results = {
            "medical_necessity": self.check_medical_necessity(diagnosis),
            "code_match": self.match_codes(diagnosis, procedure),
            "policy": self.apply_policy(procedure),
            "risk": self.detect_risk(patient)
        }

        score = sum(results.values()) / len(results)

        if score > 0.9:
            decision = "APPROVED"
        elif score > 0.7:
            decision = "REVIEW"
        else:
            decision = "DENIED"

        return decision, score, results

    def check_medical_necessity(self, diagnosis):
        return 1.0 if diagnosis else 0.0

    def match_codes(self, diagnosis, procedure):
        return 1.0 if diagnosis and procedure else 0.0

    def apply_policy(self, procedure):
        return 1.0 if procedure else 0.0

    def detect_risk(self, patient):
        return 1.0
